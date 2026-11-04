const GLOBALPING_API = "https://api.globalping.io/v1";

// Scheduler
const SCHEDULER_BATCH_SIZE = 20;
const SCHEDULER_RETRY_SECONDS = 60;

// Measurement Poller
const POLLER_BATCH_SIZE = 20;
const POLLER_MIN_INTERVAL_SECONDS = 45;

// 手动测试允许选择的三个运营商探测点
const TEST_PROBE_ASNS = {
  4134: "中国电信",
  4837: "中国联通",
  9808: "中国移动"
};

// ==================================================
// Worker 入口
// ==================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const apiKey = request.headers.get("X-Monitor-Key");

    if (!env.MONITOR_API_KEY || apiKey !== env.MONITOR_API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/api/monitor/test") {
      if (!env.GLOBALPING_TOKEN) {
        return json({ error: "GLOBALPING_TOKEN missing" }, 500);
      }
      return createMeasurement(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/monitor/result") {
      if (!env.GLOBALPING_TOKEN) {
        return json({ error: "GLOBALPING_TOKEN missing" }, 500);
      }
      return getMeasurement(url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/probes") {
      return listProbes(url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/db/test") {
      try {
        const result = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).all();

        return json({ success: true, tables: result.results });
      } catch (error) {
        return json({ success: false, error: error.message }, 500);
      }
    }

    // Webhook 配置与告警记录 API
    if (request.method === "GET" && url.pathname === "/api/webhooks") {
      return listWebhooks(env);
    }

    if (request.method === "POST" && url.pathname === "/api/webhooks") {
      return createWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/notifications") {
      return listNotifications(url, env);
    }

    const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)(?:\/(test))?$/);
    if (webhookMatch) {
      let webhookId;
      try {
        webhookId = decodeURIComponent(webhookMatch[1]);
      } catch {
        return json({ error: "Invalid webhook ID" }, 400);
      }

      if (!webhookId || webhookId.length > 128) {
        return json({ error: "Invalid webhook ID" }, 400);
      }

      if (webhookMatch[2] === "test" && request.method === "POST") {
        return testWebhook(webhookId, env);
      }
      if (request.method === "PUT") return updateWebhook(webhookId, request, env);
      if (request.method === "DELETE") return disableWebhook(webhookId, env);
      if (request.method === "GET") return getWebhook(webhookId, env);
    }

    if (request.method === "POST" && url.pathname === "/api/monitors") {
      return createMonitor(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/monitors") {
      return listMonitors(url, env);
    }

    const match = url.pathname.match(/^\/api\/monitors\/([^/]+)$/);

    if (match) {
      let id;

      try {
        id = decodeURIComponent(match[1]);
      } catch {
        return json({ error: "Invalid monitor ID" }, 400);
      }

      if (!id || id.length > 128) {
        return json({ error: "Invalid monitor ID" }, 400);
      }

      if (request.method === "GET") return getMonitor(id, env);
      if (request.method === "PUT") return updateMonitor(id, request, env);
      if (request.method === "DELETE") return disableMonitor(id, env);
    }

    return json({ error: "Not Found" }, 404);
  },

  // ==================================================
  // Cloudflare Cron 定时入口
  // ==================================================

  async scheduled(controller, env, ctx) {
    console.log("Cron triggered:", {
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString()
    });

    const errors = [];

    try {
      await runScheduler(env);
    } catch (error) {
      console.error("Scheduler execution failed:", error);
      errors.push("scheduler");
    }

    try {
      await runMeasurementPoller(env);
    } catch (error) {
      console.error("Measurement poller execution failed:", error);
      errors.push("poller");
    }

    try {
      await processPendingNotifications(env);
    } catch (error) {
      console.error("Webhook retry processor failed:", error);
      errors.push("webhook-retry");
    }

    if (errors.length > 0) {
      throw new Error("Cron tasks failed: " + errors.join(", "));
    }

    console.log("Cron execution completed");
  }
};

// ==================================================
// 统一规范化探测位置配置
// ==================================================

function normalizeLocations(locations) {
  if (
    !Array.isArray(locations) ||
    locations.length < 1 ||
    locations.length > 5
  ) {
    return {
      error: "locations must contain 1-5 location conditions"
    };
  }

  const normalized = [];

  for (const item of locations) {
    const source = typeof item === "string"
      ? { country: item }
      : item;

    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return { error: "Invalid location condition" };
    }

    const location = {};

    if (source.country !== undefined) {
      if (
        typeof source.country !== "string" ||
        !/^[A-Za-z]{2}$/.test(source.country)
      ) {
        return { error: "Invalid country code" };
      }
      location.country = source.country.toUpperCase();
    }

    if (source.city !== undefined) {
      if (
        typeof source.city !== "string" ||
        !source.city.trim() ||
        source.city.trim().length > 100
      ) {
        return { error: "Invalid city" };
      }
      location.city = source.city.trim();
    }

    if (source.asn !== undefined) {
      if (!Number.isInteger(source.asn) || source.asn < 1) {
        return { error: "Invalid ASN" };
      }
      location.asn = source.asn;
    }

    if (source.network !== undefined) {
      if (
        typeof source.network !== "string" ||
        !source.network.trim() ||
        source.network.trim().length > 150
      ) {
        return { error: "Invalid network" };
      }
      location.network = source.network.trim();
    }

    if (
      !location.country &&
      !location.city &&
      !location.asn &&
      !location.network
    ) {
      return {
        error: "Each location must contain country, city, ASN or network"
      };
    }

    const limit = source.limit === undefined ? 1 : source.limit;

    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      return { error: "Location limit must be 1-10" };
    }

    location.limit = limit;
    normalized.push(location);
  }

  return { data: normalized };
}

// ==================================================
// Globalping：查询当前在线探测节点
// ==================================================

async function listProbes(url, env) {
  if (!env.GLOBALPING_TOKEN) {
    return json({ error: "GLOBALPING_TOKEN missing" }, 500);
  }

  const country = url.searchParams.get("country");
  const city = url.searchParams.get("city");
  const asn = url.searchParams.get("asn");
  const network = url.searchParams.get("network");

  if (country && !/^[A-Za-z]{2}$/.test(country)) {
    return json({ error: "Invalid country code" }, 400);
  }

  if (city && city.length > 100) {
    return json({ error: "Invalid city" }, 400);
  }

  if (asn && (!/^\d+$/.test(asn) || Number(asn) < 1)) {
    return json({ error: "Invalid ASN" }, 400);
  }

  if (network && network.length > 150) {
    return json({ error: "Invalid network" }, 400);
  }

  try {
    const response = await fetch(`${GLOBALPING_API}/probes`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${env.GLOBALPING_TOKEN}`,
        "Accept": "application/json"
      }
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      return json({
        error: "Globalping probes API error",
        status: response.status,
        details: result
      }, response.status);
    }

    if (!Array.isArray(result)) {
      return json({ error: "Invalid Globalping probes response" }, 502);
    }

    const filtered = result.filter(probe => {
      const location = probe.location || {};

      if (country && location.country?.toUpperCase() !== country.toUpperCase()) {
        return false;
      }

      if (city && location.city?.toLowerCase() !== city.toLowerCase()) {
        return false;
      }

      if (asn && Number(location.asn) !== Number(asn)) {
        return false;
      }

      if (network && location.network?.toLowerCase() !== network.toLowerCase()) {
        return false;
      }

      return true;
    });

    const cities = {};
    const networks = {};
    const asns = {};

    for (const probe of filtered) {
      const location = probe.location || {};

      if (location.city) {
        cities[location.city] = (cities[location.city] || 0) + 1;
      }

      if (location.network) {
        networks[location.network] = (networks[location.network] || 0) + 1;
      }

      if (location.asn !== undefined && location.asn !== null) {
        const key = String(location.asn);
        asns[key] = (asns[key] || 0) + 1;
      }
    }

    return json({
      success: true,
      total: filtered.length,
      filters: {
        country: country?.toUpperCase() || null,
        city: city || null,
        asn: asn ? Number(asn) : null,
        network: network || null
      },
      summary: { cities, networks, asns },
      probes: filtered.map(probe => {
        const location = probe.location || {};

        return {
          continent: location.continent || null,
          region: location.region || null,
          country: location.country || null,
          state: location.state || null,
          city: location.city || null,
          asn: location.asn ?? null,
          network: location.network || null,
          latitude: location.latitude ?? null,
          longitude: location.longitude ?? null,
          version: probe.version || null,
          tags: probe.tags || [],
          resolvers: probe.resolvers || []
        };
      })
    });

  } catch (error) {
    console.error("Globalping probes request failed:", error);
    return json({
      error: "Globalping probes request failed",
      details: error.message
    }, 502);
  }
}

async function runScheduler(env) {
  if (!env.DB) {
    console.error("Scheduler: D1 binding DB missing");
    return;
  }

  if (!env.GLOBALPING_TOKEN) {
    console.error("Scheduler: GLOBALPING_TOKEN missing");
    return;
  }

  const nowText = new Date().toISOString();

  console.log("Scheduler started:", nowText);

  const result = await env.DB.prepare(`
    SELECT *
    FROM monitors
    WHERE enabled = 1
      AND (
        next_check_at IS NULL
        OR next_check_at <= ?
      )
    ORDER BY
      CASE
        WHEN next_check_at IS NULL THEN 0
        ELSE 1
      END,
      next_check_at ASC
    LIMIT ?
  `).bind(nowText, SCHEDULER_BATCH_SIZE).all();

  const monitors = result.results || [];

  console.log("Scheduler due monitors:", monitors.length);

  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const monitor of monitors) {
    const scheduleResult = await scheduleMonitor(monitor, env);

    if (scheduleResult === "submitted") submitted++;
    else if (scheduleResult === "failed") failed++;
    else skipped++;
  }

  console.log("Scheduler finished:", {
    total: monitors.length,
    submitted,
    failed,
    skipped
  });
}

// ==================================================
// Globalping 测量结果轮询主函数
// ==================================================

async function runMeasurementPoller(env) {
  if (!env.DB) throw new Error("Poller: D1 binding DB missing");
  if (!env.GLOBALPING_TOKEN) throw new Error("Poller: GLOBALPING_TOKEN missing");

  const pollBefore = new Date(
    Date.now() - POLLER_MIN_INTERVAL_SECONDS * 1000
  ).toISOString();

  console.log("Measurement poller started:", new Date().toISOString());

  const result = await env.DB.prepare(`
    SELECT *
    FROM measurements
    WHERE status = 'submitted'
      AND (
        last_polled_at IS NULL
        OR last_polled_at <= ?
      )
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(pollBefore, POLLER_BATCH_SIZE).all();

  const measurements = result.results || [];

  console.log("Measurement poller pending:", measurements.length);

  let finished = 0;
  let inProgress = 0;
  let failed = 0;
  let skipped = 0;

  for (const measurement of measurements) {
    try {
      const pollResult = await pollSingleMeasurement(measurement, env);

      if (pollResult === "finished") finished++;
      else if (pollResult === "in-progress") inProgress++;
      else if (pollResult === "failed") failed++;
      else skipped++;

    } catch (error) {
      console.error("Measurement polling failed:", {
        measurement_id: measurement.id,
        globalping_id: measurement.globalping_id,
        error: error.message
      });

      failed++;
    }
  }

  console.log("Measurement poller finished:", {
    total: measurements.length,
    finished,
    in_progress: inProgress,
    failed,
    skipped
  });
}

// ==================================================
// 轮询单个 Globalping 测量任务
// ==================================================

async function pollSingleMeasurement(measurement, env) {
  const nowText = new Date().toISOString();

  const pollBefore = new Date(
    Date.now() - POLLER_MIN_INTERVAL_SECONDS * 1000
  ).toISOString();

  // --------------------------------------------------
  // 1. 原子抢占测量任务，避免重复轮询
  // --------------------------------------------------

  const claim = await env.DB.prepare(`
    UPDATE measurements
    SET last_polled_at = ?
    WHERE id = ?
      AND status = 'submitted'
      AND (
        last_polled_at IS NULL
        OR last_polled_at <= ?
      )
  `).bind(nowText, measurement.id, pollBefore).run();

  if (!claim.meta || claim.meta.changes !== 1) {
    console.log("Measurement polling skipped, already claimed:", measurement.id);
    return "skipped";
  }

  // --------------------------------------------------
  // 2. 请求 Globalping
  // --------------------------------------------------

  let response;
  let result;

  try {
    response = await fetch(
      `${GLOBALPING_API}/measurements/${encodeURIComponent(measurement.globalping_id)}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${env.GLOBALPING_TOKEN}`,
          "Accept": "application/json"
        }
      }
    );

    result = await response.json().catch(() => null);

  } catch (error) {
    // 网络异常：保留 submitted，等待下次轮询
    console.error("Globalping polling network error:", {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id,
      error: error.message
    });

    return "retry";
  }

  // --------------------------------------------------
  // 3. HTTP 错误处理
  // --------------------------------------------------

  if (!response.ok) {
    const errorMessage =
      `Globalping API error ${response.status}: ${JSON.stringify(result)}`;

    console.error("Globalping polling API error:", {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id,
      status: response.status,
      details: result
    });

    // 429 / 5xx：临时错误，保留 submitted
    if (response.status === 429 || response.status >= 500) {
      return "retry";
    }

    // 其他 HTTP 错误：记录为 API 异常
    await env.DB.prepare(`
      UPDATE measurements
      SET status = 'api_error',
          error_message = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(errorMessage, measurement.id).run();

    // 不调用 evaluateMonitorStatus()
    return "api_error";
  }

  // --------------------------------------------------
  // 4. 检查响应格式
  // --------------------------------------------------

  if (!result || typeof result.status !== "string") {
    const errorMessage = "Invalid Globalping measurement response";

    console.error(errorMessage, {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id
    });

    await env.DB.prepare(`
      UPDATE measurements
      SET status = 'api_error',
          error_message = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(errorMessage, measurement.id).run();

    return "api_error";
  }

  // --------------------------------------------------
  // 5. 测量仍在执行
  // --------------------------------------------------

  if (result.status === "in-progress") {
    console.log("Measurement still in progress:", {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id
    });

    return "in-progress";
  }

  // --------------------------------------------------
  // 6. 未知测量状态
  // --------------------------------------------------

  if (result.status !== "finished") {
    const errorMessage =
      `Unexpected Globalping measurement status: ${result.status}`;

    await env.DB.prepare(`
      UPDATE measurements
      SET status = 'api_error',
          error_message = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(errorMessage, measurement.id).run();

    console.error(errorMessage, {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id
    });

    return "api_error";
  }

  // --------------------------------------------------
  // 7. 检查 finished 响应
  // --------------------------------------------------

  if (!Array.isArray(result.results)) {
    const errorMessage =
      "Globalping finished response has no results array";

    await env.DB.prepare(`
      UPDATE measurements
      SET status = 'api_error',
          error_message = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(errorMessage, measurement.id).run();

    console.error(errorMessage, {
      measurement_id: measurement.id,
      globalping_id: measurement.globalping_id
    });

    return "api_error";
  }

  // finished 但没有探测结果，不判定目标故障
  if (result.results.length === 0) {
    const errorMessage = "Globalping finished without probe results";

    await env.DB.prepare(`
      UPDATE measurements
      SET status = 'api_error',
          error_message = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(errorMessage, measurement.id).run();

    return "api_error";
  }

  // --------------------------------------------------
  // 8. 保存探测节点结果
  // --------------------------------------------------

  const counts = await saveProbeResults(
    measurement,
    result.results,
    env
  );

  const finishedAt = new Date().toISOString();

  // --------------------------------------------------
  // 9. 更新测量状态
  // --------------------------------------------------

  const updateResult = await env.DB.prepare(`
    UPDATE measurements
    SET status = 'finished',
        successful_probes = ?,
        failed_probes = ?,
        probes_count = ?,
        finished_at = ?,
        error_message = NULL
    WHERE id = ?
      AND status = 'submitted'
  `).bind(
    counts.successful,
    counts.failed,
    result.probesCount ?? result.results.length,
    finishedAt,
    measurement.id
  ).run();

  // 如果更新失败或任务状态已变化，不继续评估
  if (!updateResult.meta || updateResult.meta.changes !== 1) {
    console.error("Measurement status update skipped:", measurement.id);
    return "skipped";
  }

  // --------------------------------------------------
  // 10. 根据探测结果更新监控状态
  // --------------------------------------------------

  await evaluateMonitorStatus(measurement.monitor_id, env);

  console.log("Measurement completed:", {
    measurement_id: measurement.id,
    globalping_id: measurement.globalping_id,
    probes_count: result.probesCount,
    results_count: result.results.length,
    successful_probes: counts.successful,
    failed_probes: counts.failed
  });

  return "finished";
}

// ==================================================
// 保存 Globalping 探测节点结果
// ==================================================

async function saveProbeResults(measurement, results, env) {
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const item = results[i] || {};
    const probe = item.probe || {};
    const probeResult = item.result || {};
    const stats = probeResult.stats || {};

    const total = toNullableNumber(stats.total);
    const received = toNullableNumber(stats.rcv);
    const packetLoss = toNullableNumber(stats.loss);

    let lost = null;

    if (total !== null && received !== null) {
      lost = Math.max(total - received, 0);
    }

    const isSuccessful =
      probeResult.status === "finished" &&
      received !== null &&
      received > 0;

    if (isSuccessful) successful++;
    else failed++;

    let errorMessage = null;

    if (!isSuccessful) {
      errorMessage =
        probeResult.failureSource ||
        probeResult.rawOutput ||
        probeResult.status ||
        "Probe did not return a successful ping response";
    }

    const probeResultId = `${measurement.id}-${i}`;

    await env.DB.prepare(`
      INSERT OR IGNORE INTO probe_results (
        id,
        measurement_id,
        country,
        city,
        network,
        asn,
        probe_status,
        latency_min,
        latency_avg,
        latency_max,
        packets_sent,
        packets_received,
        packets_lost,
        packet_loss,
        error_message,
        raw_output,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      probeResultId,
      measurement.id,
      probe.country || null,
      probe.city || null,
      probe.network || null,
      toNullableNumber(probe.asn),
      probeResult.status || null,
      toNullableNumber(stats.min),
      toNullableNumber(stats.avg),
      toNullableNumber(stats.max),
      total,
      received,
      lost,
      packetLoss,
      errorMessage,
      typeof probeResult.rawOutput === "string"
        ? probeResult.rawOutput
        : JSON.stringify(probeResult),
      new Date().toISOString()
    ).run();
  }

  return { successful, failed };
}

// ==================================================
// 监控状态判定
//
// 返回值：success / failure / suspect
//
// success：所有探测节点成功，且丢包率均未超过阈值
// failure：所有探测节点均失败
// suspect：部分成功、部分失败，或丢包率超限
// ==================================================

async function classifyMeasurement(measurement, env) {
  if (measurement.status === "failed") {
    return "failure";
  }

  if (measurement.status !== "finished") {
    return null;
  }

  const result = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN probe_status = 'finished'
            AND packets_received > 0
            THEN 1
          ELSE 0
        END
      ) AS successful,
      SUM(
        CASE
          WHEN probe_status = 'finished'
            AND packets_received > 0
            AND (
              packet_loss IS NULL
              OR packet_loss <= ?
            )
            THEN 1
          ELSE 0
        END
      ) AS acceptable
    FROM probe_results
    WHERE measurement_id = ?
  `).bind(
    Number(measurement.loss_threshold),
    measurement.id
  ).first();

  const total = Number(result?.total || 0);
  const successful = Number(result?.successful || 0);
  const acceptable = Number(result?.acceptable || 0);

  if (total === 0) {
    return "failure";
  }

  if (successful === 0) {
    return "failure";
  }

  if (successful === total && acceptable === total) {
    return "success";
  }

  return "suspect";
}

// ==================================================
// 根据最近测量记录计算连续成功/失败次数
// ==================================================

async function evaluateMonitorStatus(monitorId, env) {
  if (!monitorId) return;

  const monitor = await env.DB.prepare(`
    SELECT *
    FROM monitors
    WHERE id = ?
  `).bind(monitorId).first();

  if (!monitor) {
    console.warn("Monitor not found during status evaluation:", monitorId);
    return;
  }

  const previousStatus = monitor.current_status || "UNKNOWN";

  const maxHistory = Math.max(
    Number(monitor.failure_threshold || 3),
    Number(monitor.success_threshold || 2)
  );

  const historyResult = await env.DB.prepare(`
    SELECT *
    FROM measurements
    WHERE monitor_id = ?
      AND status IN ('finished', 'failed')
    ORDER BY
      COALESCE(finished_at, created_at) DESC,
      created_at DESC
    LIMIT ?
  `).bind(monitorId, maxHistory + 5).all();

  const history = historyResult.results || [];

  if (history.length === 0) {
    return;
  }

  let latestOutcome = null;
  let consecutiveCount = 0;

  for (const measurement of history) {
    const outcome = await classifyMeasurement(
      {
        ...measurement,
        loss_threshold: monitor.loss_threshold
      },
      env
    );

    if (!outcome) continue;

    if (latestOutcome === null) {
      latestOutcome = outcome;
      consecutiveCount = 1;
      continue;
    }

    if (outcome === latestOutcome) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  if (!latestOutcome) return;

  let newStatus;

  if (latestOutcome === "success") {
    newStatus =
      consecutiveCount >= Number(monitor.success_threshold || 2)
        ? "UP"
        : "SUSPECT";

  } else if (latestOutcome === "failure") {
    newStatus =
      consecutiveCount >= Number(monitor.failure_threshold || 3)
        ? "DOWN"
        : "SUSPECT";

  } else {
    newStatus = "SUSPECT";
  }

  const now = new Date().toISOString();

  const latestSuccessful = latestOutcome === "success";

  // 状态没有变化，只更新检查时间和最近成功时间。
  if (newStatus === previousStatus) {
    await env.DB.prepare(`
      UPDATE monitors
      SET last_checked_at = ?,
          last_success_at = CASE
            WHEN ? = 1 THEN ?
            ELSE last_success_at
          END
      WHERE id = ?
    `).bind(
      now,
      latestSuccessful ? 1 : 0,
      now,
      monitorId
    ).run();

    return;
  }

  // 状态发生变化：更新监控对象，并记录事件。
  const eventId = crypto.randomUUID();

  const message = buildStatusMessage(
    previousStatus,
    newStatus,
    latestOutcome,
    consecutiveCount
  );

  const details = {
    previous_status: previousStatus,
    current_status: newStatus,
    latest_outcome: latestOutcome,
    consecutive_count: consecutiveCount,
    failure_threshold: Number(monitor.failure_threshold || 3),
    success_threshold: Number(monitor.success_threshold || 2),
    loss_threshold: Number(monitor.loss_threshold),
    evaluated_at: now
  };

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE monitors
      SET current_status = ?,
          last_checked_at = ?,
          last_success_at = CASE
            WHEN ? = 1 THEN ?
            ELSE last_success_at
          END
      WHERE id = ?
    `).bind(
      newStatus,
      now,
      latestSuccessful ? 1 : 0,
      now,
      monitorId
    ),

    env.DB.prepare(`
      INSERT INTO monitor_events (
        id,
        monitor_id,
        event_type,
        previous_status,
        current_status,
        message,
        details_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      monitorId,
      "status_changed",
      previousStatus,
      newStatus,
      message,
      JSON.stringify(details),
      now
    )
  ]);

  // DOWN 故障事件直接触发；恢复事件需要确认此前最近一次稳定状态是 DOWN。
  // 状态机可能经过 DOWN -> SUSPECT -> UP，因此不能只判断 previousStatus === DOWN。
  let shouldNotify = newStatus === "DOWN";

  if (newStatus === "UP") {
    const previousStableEvent = await env.DB.prepare(`
      SELECT current_status
      FROM monitor_events
      WHERE monitor_id = ?
        AND id != ?
        AND current_status IN ('DOWN', 'UP')
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(monitorId, eventId).first();

    shouldNotify = previousStableEvent?.current_status === "DOWN";
  }

  if (shouldNotify) {
    try {
      await enqueueStatusNotifications(eventId, monitorId, newStatus, env);
    } catch (error) {
      console.error("Webhook notification enqueue failed:", {
        event_id: eventId,
        monitor_id: monitorId,
        error: error.message
      });
    }
  }

  console.log("Monitor status changed:", {
    monitor_id: monitorId,
    previous_status: previousStatus,
    current_status: newStatus,
    latest_outcome: latestOutcome,
    consecutive_count: consecutiveCount
  });
}

function buildStatusMessage(
  previousStatus,
  currentStatus,
  outcome,
  consecutiveCount
) {
  const statusNames = {
    UNKNOWN: "未知",
    UP: "正常",
    SUSPECT: "异常",
    DOWN: "不可用"
  };

  const previousName = statusNames[previousStatus] || previousStatus;
  const currentName = statusNames[currentStatus] || currentStatus;

  let reason = "";

  if (outcome === "success") {
    reason = `连续成功测量 ${consecutiveCount} 次`;
  } else if (outcome === "failure") {
    reason = `连续失败测量 ${consecutiveCount} 次`;
  } else {
    reason = "探测结果存在部分失败或丢包率超限";
  }

  return `监控状态由${previousName}变更为${currentName}：${reason}`;
}

// ==================================================
// 数字转换
// ==================================================

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

// ==================================================
// 调度单个监控对象
// ==================================================

async function scheduleMonitor(monitor, env) {
  const now = new Date();
  const nowText = now.toISOString();

  const intervalSeconds = monitor.interval_seconds;

  const nextCheckAt = new Date(
    now.getTime() + intervalSeconds * 1000
  ).toISOString();

  try {
    const claim = await env.DB.prepare(`
      UPDATE monitors
      SET next_check_at = ?
      WHERE id = ?
        AND enabled = 1
        AND (
          next_check_at IS NULL
          OR next_check_at <= ?
        )
    `).bind(nextCheckAt, monitor.id, nowText).run();

    if (!claim.meta || claim.meta.changes !== 1) {
      console.log("Scheduler skipped, already claimed or disabled:", monitor.id);
      return "skipped";
    }

    let configuredLocations;

    try {
      configuredLocations = JSON.parse(monitor.locations_json);
    } catch {
      throw new Error("Invalid locations_json");
    }

    const locationValidation = normalizeLocations(configuredLocations);

    if (locationValidation.error) {
      throw new Error(locationValidation.error);
    }

    const locations = locationValidation.data;

    const globalpingResult = await submitGlobalpingMeasurement({
      target: monitor.target,
      type: monitor.monitor_type,
      locations,
      packets: monitor.packets
    }, env);

    if (
      !globalpingResult ||
      typeof globalpingResult.id !== "string" ||
      !globalpingResult.id
    ) {
      throw new Error("Globalping response does not contain measurement ID");
    }

    const measurementId = crypto.randomUUID();
    const submittedAt = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO measurements (
        id,
        monitor_id,
        globalping_id,
        target,
        measurement_type,
        status,
        probes_count,
        successful_probes,
        failed_probes,
        created_at,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      measurementId,
      monitor.id,
      globalpingResult.id,
      monitor.target,
      monitor.monitor_type,
      "submitted",
      Number(globalpingResult.probesCount || 0),
      0,
      0,
      submittedAt,
      submittedAt
    ).run();

    console.log("Measurement submitted:", {
      monitor_id: monitor.id,
      measurement_id: measurementId,
      globalping_id: globalpingResult.id,
      probes_count: globalpingResult.probesCount || 0
    });

    return "submitted";

  } catch (error) {
    console.error("Monitor scheduling failed:", {
      monitor_id: monitor.id,
      target: monitor.target,
      error: error.message,
      http_status: error.httpStatus || null,
      response_body: error.responseBody || null,
      stack: error.stack || null
    });

    const retryAt = new Date(
      Date.now() + SCHEDULER_RETRY_SECONDS * 1000
    ).toISOString();

    try {
      await env.DB.prepare(`
        UPDATE monitors
        SET next_check_at = ?
        WHERE id = ?
          AND enabled = 1
          AND next_check_at = ?
      `).bind(retryAt, monitor.id, nextCheckAt).run();

    } catch (dbError) {
      console.error("Failed to update monitor retry time:", dbError.message);
    }

    return "failed";
  }
}

// ==================================================
// 向 Globalping 提交测量任务
// ==================================================

async function submitGlobalpingMeasurement(data, env) {
  const payload = {
    type: data.type,
    target: data.target,
    locations: data.locations,
    measurementOptions: {
      protocol: "ICMP",
      packets: data.packets
    }
  };

  const response = await fetch(`${GLOBALPING_API}/measurements`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GLOBALPING_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  let result = null;

  try {
    result = responseText ? JSON.parse(responseText) : null;
  } catch {
    // 保留原始响应正文，便于诊断非 JSON 响应
  }

  if (!response.ok) {
    const error = new Error(
      `Globalping API error ${response.status}: ${responseText.slice(0, 2000)}`
    );

    error.httpStatus = response.status;
    error.responseBody = responseText.slice(0, 2000);

    throw error;
  }

  if (!result || typeof result.id !== "string" || !result.id) {
    throw new Error(
      `Invalid Globalping response: ${responseText.slice(0, 2000)}`
    );
  }

  return result;
}

// ==================================================
// Globalping：手动创建一次 Ping 测量
// ==================================================

async function createMeasurement(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request body" }, 400);
  }

  const target = body.target;
  const type = body.type || body.monitor_type;

  if (
    typeof target !== "string" ||
    target.trim().length < 1 ||
    target.trim().length > 253
  ) {
    return json({ error: "Invalid target" }, 400);
  }

  if (type !== "ping") {
    return json({ error: "Only ping is supported" }, 400);
  }

  let selectedLocation;

  if (body.location !== undefined) {
    if (body.locations !== undefined) {
      return json({
        error: "Use either location or locations, not both"
      }, 400);
    }

    selectedLocation = body.location;

  } else if (Array.isArray(body.locations)) {
    if (body.locations.length !== 1) {
      return json({
        error: "Manual test requires exactly one location"
      }, 400);
    }

    selectedLocation = body.locations[0];

  } else {
    return json({
      error: "location is required"
    }, 400);
  }

  const locationValidation = normalizeLocations([selectedLocation]);

  if (locationValidation.error) {
    return json({ error: locationValidation.error }, 400);
  }

  const normalizedLocation = locationValidation.data[0];

  if (
    normalizedLocation.asn === undefined ||
    !Object.prototype.hasOwnProperty.call(
      TEST_PROBE_ASNS,
      normalizedLocation.asn
    )
  ) {
    return json({
      error: "Invalid test ASN. Supported ASNs: 4134, 4837, 9808",
      supported_probes: [
        { asn: 4134, name: TEST_PROBE_ASNS[4134] },
        { asn: 4837, name: TEST_PROBE_ASNS[4837] },
        { asn: 9808, name: TEST_PROBE_ASNS[9808] }
      ]
    }, 400);
  }

  const packets = body.packets === undefined ? 3 : body.packets;

  if (!Number.isInteger(packets) || packets < 1 || packets > 10) {
    return json({ error: "packets must be 1-10" }, 400);
  }

  const payload = {
    type: "ping",
    target: target.trim(),
    locations: [normalizedLocation],
    measurementOptions: {
      protocol: "ICMP",
      packets
    }
  };

  try {
    const response = await fetch(`${GLOBALPING_API}/measurements`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GLOBALPING_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      return json({
        error: "Globalping API error",
        status: response.status,
        details: result
      }, response.status);
    }

    return json({
      success: true,
      measurement_id: result.id,
      probes_count: result.probesCount,
      status: "submitted",
      target: target.trim(),
      selected_probe: {
        asn: normalizedLocation.asn,
        name: TEST_PROBE_ASNS[normalizedLocation.asn]
      },
      location: normalizedLocation,
      packets
    }, 202);

  } catch (error) {
    return json({
      error: "Globalping request failed",
      details: error.message
    }, 502);
  }
}

// ==================================================
// Globalping：查询测量结果
// ==================================================

async function getMeasurement(url, env) {
  const id = url.searchParams.get("id");

  if (
    !id ||
    id.length > 128 ||
    !/^[A-Za-z0-9\_-]+$/.test(id)
  ) {
    return json({ error: "Invalid measurement ID" }, 400);
  }

  try {
    const response = await fetch(
      `${GLOBALPING_API}/measurements/${encodeURIComponent(id)}`,
      {
        headers: {
          "Authorization": `Bearer ${env.GLOBALPING_TOKEN}`,
          "Accept": "application/json"
        }
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      return json({
        error: "Globalping API error",
        status: response.status,
        details: result
      }, response.status);
    }

    return json(result);

  } catch (error) {
    return json({
      error: "Globalping request failed",
      details: error.message
    }, 502);
  }
}

// ==================================================
// 监控对象配置校验
// ==================================================
function validateMonitorInput(body, current = null) {
  let currentLocations = [{ country: "CN", limit: 3 }];

  if (current) {
    try {
      currentLocations = JSON.parse(current.locations_json);
    } catch {
      return { error: "Existing monitor locations_json is invalid" };
    }
  }

  const data = {
    name: current?.name ?? "",
    description: current?.description ?? null,
    target: current?.target ?? "",
    monitor_type: current?.monitor_type ?? "ping",
    enabled: current ? current.enabled === 1 : true,
    interval_seconds: current?.interval_seconds ?? 300,
    locations: current ? currentLocations : [{ country: "CN", limit: 3 }],
    packets: current?.packets ?? 3,
    loss_threshold: current?.loss_threshold ?? 50,
    failure_threshold: current?.failure_threshold ?? 3,
    success_threshold: current?.success_threshold ?? 2,
    site_id: current?.site_id ?? null
  };

  for (const key of Object.keys(data)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      data[key] = body[key];
    }
  }

  if (typeof data.name !== "string") {
    return { error: "Invalid name" };
  }

  data.name = data.name.trim();

  if (!data.name || data.name.length > 100) {
    return { error: "name is required and must be <= 100 characters" };
  }

  if (typeof data.target !== "string") {
    return { error: "Invalid target" };
  }

  data.target = data.target.trim();

  if (
    !data.target ||
    data.target.length > 253 ||
    /[\s/]/.test(data.target) ||
    data.target.includes("://")
  ) {
    return { error: "Invalid target" };
  }

  if (data.monitor_type !== "ping") {
    return { error: "Only ping monitor_type is supported currently" };
  }

  const locationValidation = normalizeLocations(data.locations);

  if (locationValidation.error) {
    return { error: locationValidation.error };
  }

  data.locations = locationValidation.data;

  if (
    !Number.isInteger(data.interval_seconds) ||
    data.interval_seconds < 60 ||
    data.interval_seconds > 86400
  ) {
    return { error: "interval_seconds must be 60-86400" };
  }

  if (!Number.isInteger(data.packets) || data.packets < 1 || data.packets > 10) {
    return { error: "packets must be 1-10" };
  }

  if (
    typeof data.loss_threshold !== "number" ||
    !Number.isFinite(data.loss_threshold) ||
    data.loss_threshold < 0 ||
    data.loss_threshold > 100
  ) {
    return { error: "loss_threshold must be 0-100" };
  }

  if (
    !Number.isInteger(data.failure_threshold) ||
    data.failure_threshold < 1 ||
    data.failure_threshold > 20
  ) {
    return { error: "failure_threshold must be 1-20" };
  }

  if (
    !Number.isInteger(data.success_threshold) ||
    data.success_threshold < 1 ||
    data.success_threshold > 20
  ) {
    return { error: "success_threshold must be 1-20" };
  }

  if (typeof data.enabled !== "boolean") {
    return { error: "enabled must be boolean" };
  }

  if (
    data.description !== null &&
    (
      typeof data.description !== "string" ||
      data.description.length > 500
    )
  ) {
    return { error: "description must be <= 500 characters" };
  }

  if (
    data.site_id !== null &&
    (
      typeof data.site_id !== "string" ||
      !data.site_id.trim()
    )
  ) {
    return { error: "Invalid site_id" };
  }

  return { data };
}

// ==================================================
// 检查所属站点
// ==================================================

async function checkSite(siteId, env) {
  if (siteId === null) return true;

  const site = await env.DB.prepare(
    "SELECT id FROM sites WHERE id = ?"
  ).bind(siteId).first();

  return !!site;
}

// ==================================================
// 创建监控对象
// ==================================================

async function createMonitor(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object" }, 400);
  }

  const validation = validateMonitorInput(body);

  if (validation.error) {
    return json({ error: validation.error }, 400);
  }

  const data = validation.data;

  try {
    if (!(await checkSite(data.site_id, env))) {
      return json({ error: "site_id does not exist" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO monitors (
        id,
        site_id,
        name,
        description,
        target,
        monitor_type,
        enabled,
        interval_seconds,
        locations_json,
        packets,
        loss_threshold,
        failure_threshold,
        success_threshold,
        current_status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.site_id,
      data.name,
      data.description,
      data.target,
      data.monitor_type,
      data.enabled ? 1 : 0,
      data.interval_seconds,
      JSON.stringify(data.locations),
      data.packets,
      data.loss_threshold,
      data.failure_threshold,
      data.success_threshold,
      "UNKNOWN",
      now,
      now
    ).run();

    return json({
      success: true,
      monitor: {
        id,
        ...data,
        current_status: "UNKNOWN",
        last_checked_at: null,
        last_success_at: null,
        next_check_at: null,
        created_at: now,
        updated_at: now
      }
    }, 201);

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================================================
// 查询监控对象列表
// ==================================================

async function listMonitors(url, env) {
  try {
    const conditions = [];
    const params = [];

    const siteId = url.searchParams.get("site_id");

    if (siteId) {
      conditions.push("site_id = ?");
      params.push(siteId);
    }

    const enabled = url.searchParams.get("enabled");

    if (enabled !== null) {
      if (enabled !== "0" && enabled !== "1") {
        return json({ error: "enabled must be 0 or 1" }, 400);
      }

      conditions.push("enabled = ?");
      params.push(Number(enabled));
    }

    const status = url.searchParams.get("status");

    if (status) {
      const allowedStatuses = ["UNKNOWN", "UP", "SUSPECT", "DOWN"];

      if (!allowedStatuses.includes(status)) {
        return json({ error: "Invalid status" }, 400);
      }

      conditions.push("current_status = ?");
      params.push(status);
    }

    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return json({
        error: "limit must be 1-100 and offset must be >= 0"
      }, 400);
    }

    let sql = "SELECT * FROM monitors";

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    params.push(limit, offset);

    const result = await env.DB.prepare(sql).bind(...params).all();

    const monitors = (result.results || []).map(formatMonitor);

    return json({
      success: true,
      count: monitors.length,
      limit,
      offset,
      monitors
    });

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================================================
// 查询单个监控对象
// ==================================================

async function getMonitor(id, env) {
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM monitors WHERE id = ?"
    ).bind(id).first();

    if (!row) return json({ error: "Monitor not found" }, 404);

    return json({
      success: true,
      monitor: formatMonitor(row)
    });

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================================================
// 修改监控对象
// ==================================================

async function updateMonitor(id, request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object" }, 400);
  }

  try {
    const current = await env.DB.prepare(
      "SELECT * FROM monitors WHERE id = ?"
    ).bind(id).first();

    if (!current) return json({ error: "Monitor not found" }, 404);

    const validation = validateMonitorInput(body, current);

    if (validation.error) {
      return json({ error: validation.error }, 400);
    }

    const data = validation.data;

    if (!(await checkSite(data.site_id, env))) {
      return json({ error: "site_id does not exist" }, 400);
    }

    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE monitors SET
        site_id = ?,
        name = ?,
        description = ?,
        target = ?,
        monitor_type = ?,
        enabled = ?,
        interval_seconds = ?,
        locations_json = ?,
        packets = ?,
        loss_threshold = ?,
        failure_threshold = ?,
        success_threshold = ?,
        updated_at = ?
      WHERE id = ?
    `).bind(
      data.site_id,
      data.name,
      data.description,
      data.target,
      data.monitor_type,
      data.enabled ? 1 : 0,
      data.interval_seconds,
      JSON.stringify(data.locations),
      data.packets,
      data.loss_threshold,
      data.failure_threshold,
      data.success_threshold,
      now,
      id
    ).run();

    return json({
      success: true,
      message: "Monitor updated",
      monitor: {
        id,
        ...data,
        current_status: current.current_status,
        last_checked_at: current.last_checked_at,
        last_success_at: current.last_success_at,
        next_check_at: current.next_check_at,
        created_at: current.created_at,
        updated_at: now
      }
    });

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================================================
// 停用监控对象
// ==================================================

async function disableMonitor(id, env) {
  try {
    const current = await env.DB.prepare(
      "SELECT id, enabled FROM monitors WHERE id = ?"
    ).bind(id).first();

    if (!current) return json({ error: "Monitor not found" }, 404);

    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE monitors
      SET enabled = 0,
          updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();

    return json({
      success: true,
      message: "Monitor disabled",
      id,
      enabled: false,
      updated_at: now
    });

  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

// ==================================================
// 统一格式化监控对象
// ==================================================

function formatMonitor(row) {
  let locations = [];

  try {
    locations = JSON.parse(row.locations_json);

    const normalized = normalizeLocations(locations);

    if (!normalized.error) {
      locations = normalized.data;
    }

  } catch {
    locations = [];
  }

  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    description: row.description,
    target: row.target,
    monitor_type: row.monitor_type,
    enabled: row.enabled === 1,
    interval_seconds: row.interval_seconds,
    locations,
    packets: row.packets,
    loss_threshold: row.loss_threshold,
    failure_threshold: row.failure_threshold,
    success_threshold: row.success_threshold,
    current_status: row.current_status,
    last_checked_at: row.last_checked_at,
    last_success_at: row.last_success_at,
    next_check_at: row.next_check_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// ==================================================
// Webhook 告警功能
// event_types_json 使用 ["down", "up"]；DOWN 故障、UP 恢复。
// ==================================================

const WEBHOOK_MAX_BODY_LENGTH = 10000;
const WEBHOOK_RETRY_DELAYS = [60, 300, 900, 1800, 3600];
const WEBHOOK_SEND_BATCH_SIZE = 20;

function validateWebhookUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    return { error: "webhook_url must be a valid HTTPS URL" };
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return { error: "Invalid webhook_url" };
  }

  if (parsed.protocol !== "https:") {
    return { error: "Webhook URL must use HTTPS" };
  }

  const host = parsed.hostname.toLowerCase();

  if (
    host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host === "127.0.0.1" ||
    host === "0.0.0.0" || host.startsWith("10.") ||
    host.startsWith("192.168.") || host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    host === "::1" || host.startsWith("fc") || host.startsWith("fd")
  ) {
    return { error: "Private or local webhook destinations are not allowed" };
  }

  return { data: parsed.toString() };
}

function normalizeWebhookInput(input, partial = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Request body must be a JSON object" };
  }

  const out = {};

  if (!partial || input.name !== undefined) {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.trim().length > 100
    ) {
      return { error: "name is required and must be at most 100 characters" };
    }

    out.name = input.name.trim();
  }

  if (!partial || input.webhook_url !== undefined) {
    const result = validateWebhookUrl(input.webhook_url);

    if (result.error) return result;

    out.webhook_url = result.data;
  }

  if (!partial || input.body_template !== undefined) {
    if (
      typeof input.body_template !== "string" ||
      !input.body_template.trim() ||
      input.body_template.length > WEBHOOK_MAX_BODY_LENGTH
    ) {
      return { error: "body_template is required and must be at most 10000 characters" };
    }

    out.body_template = input.body_template;
  }

  if (!partial || input.event_types !== undefined) {
    if (
      !Array.isArray(input.event_types) ||
      input.event_types.length < 1 ||
      input.event_types.some(x => !["down", "up"].includes(x)) ||
      new Set(input.event_types).size !== input.event_types.length
    ) {
      return {
        error: 'event_types must be a non-empty array containing "down" and/or "up"'
      };
    }

    out.event_types_json = JSON.stringify(input.event_types);
  }

  if (input.http_method !== undefined || !partial) {
    const method = input.http_method ?? "POST";

    if (!["POST", "PUT", "PATCH"].includes(method)) {
      return { error: "http_method must be POST, PUT or PATCH" };
    }

    out.http_method = method;
  }

  if (input.headers !== undefined || !partial) {
    const headers = input.headers ?? {};

    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      return { error: "headers must be a JSON object" };
    }

    const clean = {};

    for (const [key, value] of Object.entries(headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value)
      ) {
        return { error: "Invalid webhook header" };
      }

      if (["host", "content-length", "connection"].includes(key.toLowerCase())) {
        return { error: `Header ${key} cannot be overridden` };
      }

      clean[key] = value;
    }

    out.headers_json = JSON.stringify(clean);
  }

  if (input.timeout_seconds !== undefined || !partial) {
    const n = input.timeout_seconds ?? 10;

    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return { error: "timeout_seconds must be between 1 and 30" };
    }

    out.timeout_seconds = n;
  }

  if (input.retry_count !== undefined || !partial) {
    const n = input.retry_count ?? 3;

    if (!Number.isInteger(n) || n < 0 || n > 5) {
      return { error: "retry_count must be between 0 and 5" };
    }

    out.retry_count = n;
  }

  if (input.enabled !== undefined || !partial) {
    const enabled = input.enabled ?? true;

    if (typeof enabled !== "boolean") {
      return { error: "enabled must be boolean" };
    }

    out.enabled = enabled ? 1 : 0;
  }

  return { data: out };
}

function parseWebhookRow(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    webhook_url: row.webhook_url,
    http_method: row.http_method,
    headers: safeJsonParse(row.headers_json, {}),
    body_template: row.body_template,
    event_types: safeJsonParse(row.event_types_json, []),
    timeout_seconds: row.timeout_seconds,
    retry_count: row.retry_count,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ==================================================
// 查询 Webhook 配置列表
// ==================================================

async function listWebhooks(env) {
  const result = await env.DB.prepare(
    "SELECT * FROM webhook_configs ORDER BY created_at DESC"
  ).all();

  return json({
    webhooks: (result.results || []).map(parseWebhookRow)
  });
}

// ==================================================
// 查询单个 Webhook 配置
// ==================================================

async function getWebhook(id, env) {
  const row = await env.DB.prepare(
    "SELECT * FROM webhook_configs WHERE id = ?"
  ).bind(id).first();

  if (!row) {
    return json({ error: "Webhook not found" }, 404);
  }

  return json({ webhook: parseWebhookRow(row) });
}

// ==================================================
// 创建 Webhook 配置
// ==================================================

async function createWebhook(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const normalized = normalizeWebhookInput(body, false);

  if (normalized.error) {
    return json({ error: normalized.error }, 400);
  }

  const data = normalized.data;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO webhook_configs (
      id, name, enabled, webhook_url, http_method, headers_json,
      body_template, event_types_json, timeout_seconds, retry_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.name,
    data.enabled,
    data.webhook_url,
    data.http_method,
    data.headers_json,
    data.body_template,
    data.event_types_json,
    data.timeout_seconds,
    data.retry_count,
    now,
    now
  ).run();

  return json({ success: true, webhook_id: id }, 201);
}

// ==================================================
// 修改 Webhook 配置
// ==================================================

async function updateWebhook(id, request, env) {
  const existing = await env.DB.prepare(
    "SELECT * FROM webhook_configs WHERE id = ?"
  ).bind(id).first();

  if (!existing) {
    return json({ error: "Webhook not found" }, 404);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const normalized = normalizeWebhookInput(body, true);

  if (normalized.error) {
    return json({ error: normalized.error }, 400);
  }

  const allowed = [
    "name",
    "webhook_url",
    "body_template",
    "event_types_json",
    "http_method",
    "headers_json",
    "timeout_seconds",
    "retry_count",
    "enabled"
  ];

  const data = normalized.data;
  const fields = allowed.filter(key => data[key] !== undefined);

  if (!fields.length) {
    return json({ error: "No fields to update" }, 400);
  }

  const now = new Date().toISOString();
  const assignments = fields.map(key => `${key} = ?`).join(", ");

  await env.DB.prepare(`
    UPDATE webhook_configs
    SET ${assignments}, updated_at = ?
    WHERE id = ?
  `).bind(
    ...fields.map(key => data[key]),
    now,
    id
  ).run();

  return json({ success: true, webhook_id: id });
}

// ==================================================
// 停用 Webhook 配置
// ==================================================

async function disableWebhook(id, env) {
  const result = await env.DB.prepare(
    "UPDATE webhook_configs SET enabled = 0, updated_at = ? WHERE id = ?"
  ).bind(new Date().toISOString(), id).run();

  if (!result.meta || result.meta.changes === 0) {
    return json({ error: "Webhook not found" }, 404);
  }

  return json({ success: true, enabled: false });
}

// ==================================================
// 查询 Webhook 发送记录
// ==================================================

async function listNotifications(url, env) {
  const limitRaw = Number(url.searchParams.get("limit") || 50);
  const offsetRaw = Number(url.searchParams.get("offset") || 0);

  if (
    !Number.isInteger(limitRaw) ||
    limitRaw < 1 ||
    limitRaw > 100 ||
    !Number.isInteger(offsetRaw) ||
    offsetRaw < 0
  ) {
    return json({
      error: "limit must be 1-100 and offset must be non-negative"
    }, 400);
  }

  const result = await env.DB.prepare(`
    SELECT n.id, n.event_id, n.webhook_config_id, n.status, n.attempt_count,
           n.http_status, n.response_body, n.error_message, n.next_retry_at,
           n.sent_at, n.created_at, n.updated_at,
           w.name AS webhook_name, m.name AS monitor_name, m.target,
           e.previous_status, e.current_status, e.message AS event_message
    FROM notification_logs n
    LEFT JOIN webhook_configs w ON w.id = n.webhook_config_id
    LEFT JOIN monitor_events e ON e.id = n.event_id
    LEFT JOIN monitors m ON m.id = e.monitor_id
    ORDER BY n.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limitRaw, offsetRaw).all();

  return json({
    notifications: result.results || [],
    limit: limitRaw,
    offset: offsetRaw
  });
}

// ==================================================
// 渲染 Webhook 消息模板
// ==================================================

function renderWebhookTemplate(template, values) {
  return template.replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => {
    const value = values[key.toLowerCase()];

    return value === undefined || value === null ? "" :
      String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
  });
}

// ==================================================
// 发送 Webhook HTTP 请求
// ==================================================

async function sendWebhookRequest(config, payload) {
  const headers = safeJsonParse(config.headers_json, {});
  const requestHeaders = new Headers(headers);

  if (!requestHeaders.has("content-type")) {
    requestHeaders.set("Content-Type", "application/json; charset=utf-8");
  }

  const controller = new AbortController();

  const timeout = Math.max(
    1,
    Math.min(30, Number(config.timeout_seconds) || 10)
  );

  const timer = setTimeout(
    () => controller.abort("Webhook timeout"),
    timeout * 1000
  );

  try {
    const response = await fetch(config.webhook_url, {
      method: config.http_method || "POST",
      headers: requestHeaders,
      body: payload,
      signal: controller.signal,
      redirect: "manual"
    });

    const responseBody = (await response.text().catch(() => "")).slice(0, 2000);

    return {
      ok: response.ok,
      http_status: response.status,
      response_body: responseBody,
      error_message: response.ok ? null : `HTTP ${response.status}`
    };

  } catch (error) {
    return {
      ok: false,
      http_status: null,
      response_body: null,
      error_message: error?.name === "AbortError"
        ? "Webhook request timeout"
        : String(error?.message || error).slice(0, 1000)
    };

  } finally {
    clearTimeout(timer);
  }
}

// ==================================================
// Webhook 测试发送
// ==================================================

async function testWebhook(id, env) {
  const config = await env.DB.prepare(
    "SELECT * FROM webhook_configs WHERE id = ?"
  ).bind(id).first();

  if (!config) {
    return json({ error: "Webhook not found" }, 404);
  }

  const sample = {
    event_type: "test",
    monitor_name: "Webhook 测试",
    target: "192.0.2.1",
    previous_status: "UP",
    current_status: "DOWN",
    message: "这是一条 Webhook 测试消息",
    event_id: "test-event",
    created_at: new Date().toISOString(),
    details_json: "{}"
  };

  const body = renderWebhookTemplate(config.body_template, sample);
  const result = await sendWebhookRequest(config, body);

  return json({
    success: result.ok,
    http_status: result.http_status,
    response_body: result.response_body,
    error: result.error_message
  }, result.ok ? 200 : 502);
}

// ==================================================
// 为监控状态变化创建通知任务
// ==================================================

async function enqueueStatusNotifications(eventId, monitorId, newStatus, env) {
  const eventType = newStatus === "DOWN" ? "down" : "up";

  const configsResult = await env.DB.prepare(
    "SELECT * FROM webhook_configs WHERE enabled = 1"
  ).all();

  const configs = configsResult.results || [];
  const now = new Date().toISOString();

  const monitor = await env.DB.prepare(
    "SELECT name, target FROM monitors WHERE id = ?"
  ).bind(monitorId).first();

  const event = await env.DB.prepare(`
    SELECT previous_status, current_status, message, details_json, created_at
    FROM monitor_events
    WHERE id = ?
  `).bind(eventId).first();

  if (!monitor || !event) return;

  for (const config of configs) {
    const types = safeJsonParse(config.event_types_json, []);

    if (!Array.isArray(types) || !types.includes(eventType)) {
      continue;
    }

    await env.DB.prepare(`
      INSERT INTO notification_logs (
        id, event_id, webhook_config_id, status, attempt_count,
        created_at, updated_at
      )
      SELECT ?, ?, ?, 'pending', 0, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_logs
        WHERE event_id = ? AND webhook_config_id = ?
      )
    `).bind(
      crypto.randomUUID(),
      eventId,
      config.id,
      now,
      now,
      eventId,
      config.id
    ).run();

    // 待发送任务已持久化，由本轮 Cron 的 processPendingNotifications 统一发送。
  }
}

// ==================================================
// 发送一条通知任务
// ==================================================

async function sendNotificationLog(logId, env) {
  const claimTime = new Date().toISOString();

  const claim = await env.DB.prepare(`
    UPDATE notification_logs
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        updated_at = ?,
        next_retry_at = NULL
    WHERE id = ?
      AND (
        status IN ('pending', 'failed')
        OR (status = 'sending' AND updated_at <= ?)
      )
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
  `).bind(
    claimTime,
    logId,
    new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    claimTime
  ).run();

  if (claim.meta && claim.meta.changes === 0) {
    return;
  }

  const row = await env.DB.prepare(`
    SELECT n.id, n.attempt_count, w.id AS config_id, w.webhook_url,
           w.http_method, w.headers_json, w.body_template,
           w.timeout_seconds, w.retry_count,
           e.id AS event_id, e.previous_status, e.current_status,
           e.message, e.details_json, e.created_at AS event_created_at,
           m.name AS monitor_name, m.target
    FROM notification_logs n
    JOIN webhook_configs w ON w.id = n.webhook_config_id
    JOIN monitor_events e ON e.id = n.event_id
    JOIN monitors m ON m.id = e.monitor_id
    WHERE n.id = ?
  `).bind(logId).first();

  if (!row) return;

  const eventType = row.current_status === "DOWN" ? "down" : "up";

  const payloadValues = {
    event_type: eventType,
    monitor_name: row.monitor_name,
    target: row.target,
    previous_status: row.previous_status,
    current_status: row.current_status,
    message: row.message,
    event_id: row.event_id,
    created_at: row.event_created_at,
    details_json: row.details_json || "{}"
  };

  const body = renderWebhookTemplate(row.body_template, payloadValues);
  const result = await sendWebhookRequest(row, body);

  const now = new Date().toISOString();
  const attemptCount = Number(row.attempt_count || 1);
  const retryCount = Number(row.retry_count || 0);

  let nextRetryAt = null;
  let finalStatus = result.ok ? "sent" : "failed";

  if (!result.ok && attemptCount <= retryCount) {
    const delay = WEBHOOK_RETRY_DELAYS[
      Math.min(attemptCount - 1, WEBHOOK_RETRY_DELAYS.length - 1)
    ];

    nextRetryAt = new Date(Date.now() + delay * 1000).toISOString();
  }

  await env.DB.prepare(`
    UPDATE notification_logs
    SET status = ?,
        http_status = ?,
        response_body = ?,
        error_message = ?,
        next_retry_at = ?,
        sent_at = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    finalStatus,
    result.http_status,
    result.response_body,
    result.error_message,
    nextRetryAt,
    result.ok ? now : null,
    now,
    logId
  ).run();

  console.log("Webhook notification result:", {
    notification_id: logId,
    status: finalStatus,
    attempt_count: attemptCount,
    http_status: result.http_status,
    next_retry_at: nextRetryAt
  });
}

// ==================================================
// 定时处理待发送通知及失败重试
// ==================================================

async function processPendingNotifications(env) {
  const now = new Date().toISOString();

  const result = await env.DB.prepare(`
    SELECT n.id
    FROM notification_logs n
    JOIN webhook_configs w ON w.id = n.webhook_config_id
    WHERE w.enabled = 1
      AND (
        (n.status = 'pending' AND (n.next_retry_at IS NULL OR n.next_retry_at <= ?))
        OR (n.status = 'failed' AND n.next_retry_at IS NOT NULL AND n.next_retry_at <= ?)
        OR (n.status = 'sending' AND n.updated_at <= ?)
      )
    ORDER BY COALESCE(n.next_retry_at, n.updated_at) ASC
    LIMIT ?
  `).bind(
    now,
    now,
    new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    WEBHOOK_SEND_BATCH_SIZE
  ).all();

  for (const row of result.results || []) {
    try {
      await sendNotificationLog(row.id, env);
    } catch (error) {
      console.error("Webhook retry failed:", row.id, error);
    }
  }
}

// ==================================================
// JSON 响应
// ==================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
