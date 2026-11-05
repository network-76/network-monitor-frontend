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

    // Device heartbeat: Uptime Kuma-style GET Push URL, independent of the management API key.
    const heartbeatPushMatch = url.pathname.match(/^\/api\/push\/([^/]+)$/);
    if (request.method === "GET" && heartbeatPushMatch) {
      let token;
      try { token = decodeURIComponent(heartbeatPushMatch[1]); }
      catch { return json({ error: "Invalid heartbeat token" }, 400); }
      return receiveHeartbeat(request, env, token);
    }

    const apiKey = request.headers.get("X-Monitor-Key");

    if (!env.MONITOR_API_KEY || apiKey !== env.MONITOR_API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Global display and notification settings.
    if (request.method === "GET" && url.pathname === "/api/settings") return getGlobalSettings(env);
    if (request.method === "PUT" && url.pathname === "/api/settings") return updateGlobalSettings(request, env);

    // Heartbeat device management APIs (management key required).
    if (request.method === "GET" && url.pathname === "/api/heartbeat/devices") {
      return listHeartbeatDevices(url, env);
    }
    if (request.method === "POST" && url.pathname === "/api/heartbeat/devices") {
      return createHeartbeatDevice(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/heartbeat/events") {
      return listHeartbeatEvents(url, env);
    }
    if (request.method === "GET" && url.pathname === "/api/heartbeat/notifications") {
      return listHeartbeatNotifications(url, env);
    }
    const heartbeatUrlMatch = url.pathname.match(/^\/api\/heartbeat\/devices\/([^/]+)\/url$/);
    if (heartbeatUrlMatch) {
      let deviceId;
      try { deviceId = decodeURIComponent(heartbeatUrlMatch[1]); }
      catch { return json({ error: "Invalid device ID" }, 400); }
      if (!deviceId || deviceId.length > 128) return json({ error: "Invalid device ID" }, 400);
      if (request.method === "GET") return getHeartbeatDeviceUrl(deviceId, request, env);
    }
    const heartbeatTokenMatch = url.pathname.match(/^\/api\/heartbeat\/devices\/([^/]+)\/token$/);
    if (heartbeatTokenMatch) {
      let deviceId;
      try { deviceId = decodeURIComponent(heartbeatTokenMatch[1]); }
      catch { return json({ error: "Invalid device ID" }, 400); }
      if (!deviceId || deviceId.length > 128) return json({ error: "Invalid device ID" }, 400);
      if (request.method === "POST") return rotateHeartbeatDeviceToken(deviceId, request, env);
    }
    const heartbeatDeviceMatch = url.pathname.match(/^\/api\/heartbeat\/devices\/([^/]+)$/);
    if (heartbeatDeviceMatch) {
      let deviceId;
      try { deviceId = decodeURIComponent(heartbeatDeviceMatch[1]); }
      catch { return json({ error: "Invalid device ID" }, 400); }
      if (!deviceId || deviceId.length > 128) return json({ error: "Invalid device ID" }, 400);
      if (request.method === "GET") return getHeartbeatDevice(deviceId, env);
      if (request.method === "PUT") return updateHeartbeatDevice(deviceId, request, env);
      if (request.method === "DELETE") return deleteHeartbeatDevice(deviceId, env);
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

    const match = url.pathname.match(/^\/api\/monitors\/([^/]+)(\/history)?$/);

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

      if (request.method === "GET" && match[2] === "/history") return getMonitorHistory(id, url, env);
      if (request.method === "GET") return getMonitor(id, env);
      if (request.method === "PUT") return updateMonitor(id, request, env);
      if (request.method === "DELETE") return deleteMonitor(id, env);
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

    try {
      await detectOfflineHeartbeatDevices(env);
      await processPendingHeartbeatNotifications(env);
    } catch (error) {
      console.error("Heartbeat processing failed:", error);
      errors.push("heartbeat");
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
      AND deleted_at IS NULL
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
      AND deleted_at IS NULL
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
        AND deleted_at IS NULL
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
    const conditions = ["deleted_at IS NULL"];
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


async function getMonitorHistory(id,url,env){
 try{
  const monitor=await env.DB.prepare("SELECT id,name,target FROM monitors WHERE id=? AND deleted_at IS NULL").bind(id).first();
  if(!monitor)return json({error:"Monitor not found"},404);
  const limit=Number(url.searchParams.get("limit")||100);
  if(!Number.isInteger(limit)||limit<1||limit>500)return json({error:"limit must be 1-500"},400);
  const q=await env.DB.prepare(`
   SELECT m.id AS measurement_id,COALESCE(m.finished_at,m.created_at) AS measured_at,m.status AS measurement_status,
    COUNT(pr.id) AS probe_count,
    SUM(CASE WHEN pr.packets_received>0 THEN 1 ELSE 0 END) AS successful_probe_count,
    AVG(CASE WHEN pr.packets_received>0 THEN pr.latency_avg END) AS latency_avg,
    MIN(CASE WHEN pr.packets_received>0 THEN pr.latency_min END) AS latency_min,
    MAX(CASE WHEN pr.packets_received>0 THEN pr.latency_max END) AS latency_max,
    AVG(pr.packet_loss) AS packet_loss
   FROM measurements m LEFT JOIN probe_results pr ON pr.measurement_id=m.id
   WHERE m.monitor_id=? AND m.status IN ('finished','failed')
   GROUP BY m.id ORDER BY COALESCE(m.finished_at,m.created_at) DESC LIMIT ?
  `).bind(id,limit).all();
  const points=(q.results||[]).reverse().map(r=>({measurement_id:r.measurement_id,measured_at:r.measured_at,status:r.measurement_status,
   probe_count:Number(r.probe_count||0),successful_probe_count:Number(r.successful_probe_count||0),
   latency_avg:r.latency_avg==null?null:Number(r.latency_avg),latency_min:r.latency_min==null?null:Number(r.latency_min),
   latency_max:r.latency_max==null?null:Number(r.latency_max),packet_loss:r.packet_loss==null?null:Number(r.packet_loss)}));
  return json({success:true,monitor,points,count:points.length});
 }catch(error){console.error("Monitor history query failed:",error);return json({success:false,error:error.message},500);}
}

// ==================================================
// 查询单个监控对象
// ==================================================

async function getMonitor(id, env) {
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM monitors WHERE id = ? AND deleted_at IS NULL"
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

async function deleteMonitor(id, env) {
  try {
    const current = await env.DB.prepare(`
      SELECT id FROM monitors
      WHERE id = ? AND deleted_at IS NULL
    `).bind(id).first();

    if (!current) return json({ error: "Monitor not found" }, 404);

    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE monitors
      SET deleted_at = ?,
          enabled = 0,
          next_check_at = NULL,
          updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).bind(now, now, id).run();

    return json({
      success: true,
      message: "Monitor deleted",
      id,
      deleted_at: now
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


// ==================================================
// 通用设备心跳监控
// ==================================================

const HEARTBEAT_DEFAULT_INTERVAL = 60;
const HEARTBEAT_DEFAULT_OFFLINE = 180;
const HEARTBEAT_BATCH_SIZE = 100;

function heartbeatDeviceView(row) {
  return {
    id: row.id, device_code: row.device_code, name: row.name,
    device_type: row.device_type, enabled: row.enabled === 1,
    has_heartbeat_url: Boolean(row.token_ciphertext),
    heartbeat_interval_seconds: row.heartbeat_interval_seconds,
    offline_threshold_seconds: row.offline_threshold_seconds,
    current_status: row.current_status, last_heartbeat_at: row.last_heartbeat_at,
    last_ip: row.last_ip, agent_version: row.agent_version,
    metadata: safeJsonParse(row.metadata_json, null),
    last_status_changed_at: row.last_status_changed_at,
    created_at: row.created_at, updated_at: row.updated_at
  };
}

function randomDeviceToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hashDeviceToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function heartbeatEncryptionKey(env) {
  if (!env.HEARTBEAT_TOKEN_ENCRYPTION_KEY) {
    throw new Error("HEARTBEAT_TOKEN_ENCRYPTION_KEY is not configured");
  }
  let raw;
  try {
    const binary = atob(env.HEARTBEAT_TOKEN_ENCRYPTION_KEY.trim());
    raw = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  } catch {
    throw new Error("HEARTBEAT_TOKEN_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  }
  if (raw.length !== 32) {
    throw new Error("HEARTBEAT_TOKEN_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, {name:"AES-GCM"}, false, ["encrypt","decrypt"]);
}

async function encryptHeartbeatToken(token, deviceId, env) {
  const key = await heartbeatEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {name:"AES-GCM", iv, additionalData:new TextEncoder().encode(deviceId)},
    key, new TextEncoder().encode(token)
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  let binary = "";
  for (const byte of combined) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function decryptHeartbeatToken(ciphertext, deviceId, env) {
  const key = await heartbeatEncryptionKey(env);
  const binary = atob(ciphertext);
  const combined = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  if (combined.length <= 12) throw new Error("Invalid encrypted heartbeat token");
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const plain = await crypto.subtle.decrypt(
    {name:"AES-GCM", iv, additionalData:new TextEncoder().encode(deviceId)},
    key, encrypted
  );
  return new TextDecoder().decode(plain);
}

async function receiveHeartbeat(request, env, token) {
  if (!env.DB) return json({ error: "D1 binding DB missing" }, 500);
  if (!token || token.length > 256) return json({ error: "Unauthorized" }, 401);

  const tokenHash = await hashDeviceToken(token);
  const device = await env.DB.prepare(
    "SELECT * FROM heartbeat_devices WHERE token_hash = ? AND enabled = 1 AND deleted_at IS NULL"
  ).bind(tokenHash).first();
  if (!device) return json({ error: "Unauthorized" }, 401);

  const now = new Date().toISOString();
  const sourceIp = request.headers.get("CF-Connecting-IP") || null;
  const agentVersion = device.agent_version;
  const metadata = device.metadata_json;
  const changed = device.current_status !== "UP";
  const eventId = changed ? crypto.randomUUID() : null;
  const previous = device.current_status || "UNKNOWN";
  const message = previous === "DOWN" ? "设备心跳恢复" : "设备首次上线";

  const statements = [
    env.DB.prepare(`
      UPDATE heartbeat_devices
      SET current_status = 'UP', last_heartbeat_at = ?, last_ip = ?,
          agent_version = ?, metadata_json = ?, last_status_changed_at = CASE WHEN ? = 1 THEN ? ELSE last_status_changed_at END,
          updated_at = ?
      WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
    `).bind(now, sourceIp, agentVersion, metadata, changed ? 1 : 0, now, now, device.id)
  ];
  if (changed) {
    statements.push(env.DB.prepare(`
      INSERT INTO heartbeat_events
      (id, device_id, previous_status, current_status, message, details_json, source_ip, created_at)
      VALUES (?, ?, ?, 'UP', ?, ?, ?, ?)
    `).bind(eventId, device.id, previous, message, JSON.stringify({agent_version: agentVersion}), sourceIp, now));
  }
  await env.DB.batch(statements);
  if (previous === "DOWN" && changed) {
    await enqueueHeartbeatNotifications(eventId, device, "up", message, sourceIp, env);
  }
  return json({ success: true, device_code: device.device_code, received_at: now });
}

async function createHeartbeatDevice(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({error:"Invalid JSON"},400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Invalid body"},400);
  const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const types = ["ac","switch","gateway","server","other"];
  const type = body.device_type || "other";
  if (!deviceCode || deviceCode.length > 100 || !name || name.length > 100 || !types.includes(type)) {
    return json({error:"device_code, name or device_type is invalid"},400);
  }
  const interval = body.heartbeat_interval_seconds ?? HEARTBEAT_DEFAULT_INTERVAL;
  const threshold = body.offline_threshold_seconds ?? HEARTBEAT_DEFAULT_OFFLINE;
  if (!Number.isInteger(interval) || interval < 10 || interval > 86400 ||
      !Number.isInteger(threshold) || threshold < interval || threshold > 604800) {
    return json({error:"Invalid heartbeat interval or offline threshold"},400);
  }
  const token = randomDeviceToken();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let encryptedToken;
  try { encryptedToken = await encryptHeartbeatToken(token, id, env); }
  catch (error) { return json({error:error.message},500); }
  try {
    await env.DB.prepare(`
      INSERT INTO heartbeat_devices
      (id,device_code,name,device_type,token_hash,token_ciphertext,enabled,heartbeat_interval_seconds,
       offline_threshold_seconds,current_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,'UNKNOWN',?,?)
    `).bind(id,deviceCode,name,type,await hashDeviceToken(token),encryptedToken,interval,threshold,now,now).run();
  } catch (error) {
    if (/UNIQUE|constraint/i.test(error.message)) return json({error:"device_code already exists"},409);
    throw error;
  }
  const heartbeatUrl = new URL("/api/push/" + encodeURIComponent(token), request.url);
  return json({
    success: true,
    device: { id, device_code: deviceCode, name },
    device_token: token,
    heartbeat_url: heartbeatUrl.toString()
  }, 201);
}

async function listHeartbeatDevices(url, env) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const result = await env.DB.prepare("SELECT * FROM heartbeat_devices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?")
    .bind(limit).all();
  return json({devices:(result.results||[]).map(heartbeatDeviceView)});
}

async function getHeartbeatDevice(id, env) {
  const row = await env.DB.prepare("SELECT * FROM heartbeat_devices WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  return row ? json({device:heartbeatDeviceView(row)}) : json({error:"Device not found"},404);
}

async function updateHeartbeatDevice(id, request, env) {
  let body;
  try { body = await request.json(); } catch { return json({error:"Invalid JSON"},400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Invalid body"},400);
  const current = await env.DB.prepare("SELECT * FROM heartbeat_devices WHERE id = ? AND deleted_at IS NULL").bind(id).first();
  if (!current) return json({error:"Device not found"},404);
  const code = body.device_code === undefined ? current.device_code : body.device_code;
  const name = body.name === undefined ? current.name : body.name;
  const type = body.device_type === undefined ? current.device_type : body.device_type;
  const interval = body.heartbeat_interval_seconds ?? current.heartbeat_interval_seconds;
  const threshold = body.offline_threshold_seconds ?? current.offline_threshold_seconds;
  const enabled = body.enabled === undefined ? current.enabled : (body.enabled === true ? 1 : body.enabled === false ? 0 : -1);
  if (typeof code !== "string" || !code.trim() || code.length > 100 ||
      typeof name !== "string" || !name.trim() || name.length > 100 ||
      !["ac","switch","gateway","server","other"].includes(type) ||
      !Number.isInteger(interval) || interval < 10 || interval > 86400 ||
      !Number.isInteger(threshold) || threshold < interval || threshold > 604800 ||
      ![0,1].includes(enabled)) return json({error:"Invalid device fields"},400);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE heartbeat_devices SET device_code=?,name=?,device_type=?,heartbeat_interval_seconds=?,
      offline_threshold_seconds=?,enabled=?,agent_version=?,metadata_json=?,updated_at=?
    WHERE id=?
  `).bind(code.trim(),name.trim(),type,interval,threshold,enabled,
    body.agent_version === undefined ? current.agent_version : body.agent_version,
    body.metadata === undefined ? current.metadata_json : JSON.stringify(body.metadata),now,id).run();
  const updated = await env.DB.prepare("SELECT * FROM heartbeat_devices WHERE id = ?").bind(id).first();
  return json({success:true,device:heartbeatDeviceView(updated)});
}

async function deleteHeartbeatDevice(id, env) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE heartbeat_devices SET enabled=0,deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL"
  ).bind(now,now,id).run();
  if (!result.meta || result.meta.changes !== 1) return json({error:"Device not found"},404);
  return json({success:true,id,deleted:true,history_retained:true});
}

function buildHeartbeatUrl(request, token) {
  return new URL("/api/push/" + encodeURIComponent(token), request.url).toString();
}

async function getHeartbeatDeviceUrl(id, request, env) {
  const row = await env.DB.prepare(
    "SELECT token_ciphertext FROM heartbeat_devices WHERE id=? AND deleted_at IS NULL"
  ).bind(id).first();
  if (!row) return json({error:"Device not found"},404);
  if (!row.token_ciphertext) {
    return json({error:"Heartbeat URL cannot be recovered for this legacy device; rotate its token to create a new URL",code:"TOKEN_NOT_RECOVERABLE"},409);
  }
  try {
    const token = await decryptHeartbeatToken(row.token_ciphertext,id,env);
    return json({success:true,heartbeat_url:buildHeartbeatUrl(request,token)});
  } catch (error) {
    console.error("Heartbeat token decryption failed",id,error);
    return json({error:"Unable to decrypt heartbeat token; verify HEARTBEAT_TOKEN_ENCRYPTION_KEY"},500);
  }
}

async function rotateHeartbeatDeviceToken(id, request, env) {
  const row = await env.DB.prepare(
    "SELECT id FROM heartbeat_devices WHERE id=? AND deleted_at IS NULL"
  ).bind(id).first();
  if (!row) return json({error:"Device not found"},404);
  const token = randomDeviceToken();
  let encryptedToken;
  try { encryptedToken = await encryptHeartbeatToken(token,id,env); }
  catch (error) { return json({error:error.message},500); }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE heartbeat_devices SET token_hash=?,token_ciphertext=?,updated_at=? WHERE id=? AND deleted_at IS NULL"
  ).bind(await hashDeviceToken(token),encryptedToken,now,id).run();
  if (!result.meta || result.meta.changes !== 1) return json({error:"Device not found"},404);
  return json({success:true,heartbeat_url:buildHeartbeatUrl(request,token),token_rotated:true});
}

async function listHeartbeatEvents(url, env) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const deviceId = url.searchParams.get("device_id");
  const query = deviceId
    ? env.DB.prepare("SELECT * FROM heartbeat_events WHERE device_id=? ORDER BY created_at DESC LIMIT ?").bind(deviceId,limit)
    : env.DB.prepare("SELECT * FROM heartbeat_events ORDER BY created_at DESC LIMIT ?").bind(limit);
  const result = await query.all();
  return json({events:result.results||[]});
}

async function listHeartbeatNotifications(url, env) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const result = await env.DB.prepare("SELECT * FROM heartbeat_notification_logs ORDER BY created_at DESC LIMIT ?")
    .bind(limit).all();
  return json({notifications:result.results||[]});
}

async function enqueueHeartbeatNotifications(eventId, device, eventType, message, sourceIp, env) {
  const configs = await env.DB.prepare("SELECT * FROM webhook_configs WHERE enabled=1").all();
  const now = new Date().toISOString();
  for (const config of configs.results || []) {
    const types = safeJsonParse(config.event_types_json, []);
    if (!Array.isArray(types) || !types.includes(eventType)) continue;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO heartbeat_notification_logs
      (id,event_id,webhook_config_id,status,attempt_count,created_at,updated_at)
      VALUES (?,?,?,'pending',0,?,?)
    `).bind(crypto.randomUUID(),eventId,config.id,now,now).run();
  }
}

async function detectOfflineHeartbeatDevices(env) {
  const nowMs = Date.now();
  const result = await env.DB.prepare(`
    SELECT * FROM heartbeat_devices
    WHERE enabled=1 AND current_status='UP' AND last_heartbeat_at IS NOT NULL
  `).all();
  for (const device of result.results || []) {
    const last = Date.parse(device.last_heartbeat_at);
    if (!Number.isFinite(last) || nowMs - last <= device.offline_threshold_seconds * 1000) continue;
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const message = "设备心跳超时，判定为离线";
    const batch = await env.DB.batch([
      env.DB.prepare(`
        UPDATE heartbeat_devices SET current_status='DOWN',last_status_changed_at=?,updated_at=?
        WHERE id=? AND enabled=1 AND current_status='UP' AND last_heartbeat_at=?
      `).bind(now,now,device.id,device.last_heartbeat_at),
      env.DB.prepare(`
        INSERT INTO heartbeat_events
        (id,device_id,previous_status,current_status,message,details_json,source_ip,created_at)
        SELECT ?,?,'UP','DOWN',?,?,last_ip,? FROM heartbeat_devices
        WHERE id=? AND current_status='DOWN' AND last_status_changed_at=?
      `).bind(eventId,device.id,message,JSON.stringify({last_heartbeat_at:device.last_heartbeat_at}),now,device.id,now)
    ]);
    if (batch?.[1]?.meta?.changes === 1) {
      await enqueueHeartbeatNotifications(eventId,device,"down",message,device.last_ip,env);
    }
  }
}

async function processPendingHeartbeatNotifications(env) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now()-300000).toISOString();
  const result = await env.DB.prepare(`
    SELECT l.*, e.device_id, e.previous_status, e.current_status, e.message,
      e.details_json, e.source_ip, e.created_at AS event_created_at,
      d.device_code,d.name AS device_name,d.device_type,d.last_ip,
      w.webhook_url,w.http_method,w.headers_json,w.body_template,w.timeout_seconds,w.retry_count
    FROM heartbeat_notification_logs l
    JOIN heartbeat_events e ON e.id=l.event_id
    JOIN heartbeat_devices d ON d.id=e.device_id
    JOIN webhook_configs w ON w.id=l.webhook_config_id
    WHERE w.enabled=1 AND (
      l.status='pending'
      OR (l.status='failed' AND l.next_retry_at IS NOT NULL AND l.next_retry_at<=?)
      OR (l.status='sending' AND l.updated_at<=?)
    )
    ORDER BY l.created_at ASC LIMIT ?
  `).bind(now,stale,HEARTBEAT_BATCH_SIZE).all();
  for (const row of result.results || []) {
    const claim = await env.DB.prepare(`
      UPDATE heartbeat_notification_logs SET status='sending',updated_at=?
      WHERE id=? AND (
        status IN ('pending','failed') OR (status='sending' AND updated_at<=?)
      )
    `).bind(now,row.id,stale).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const eventType = row.current_status === "DOWN" ? "down" : "up";
    const values = {
      event_type:eventType,
      is_heartbeat:true,
      monitor_name:row.device_name,
      device_name:row.device_name,
      device_code:row.device_code,
      device_type:row.device_type,
      target:"",
      previous_status:row.previous_status,
      current_status:row.current_status,
      status_icon:row.current_status === "DOWN" ? "🔴" : "🟢",
      message:row.message,
      event_id:row.event_id,
      created_at:await formatTimestampForTimezone(row.event_created_at,env),
      last_ip:row.last_ip || row.source_ip,
      details_json:row.details_json || "{}"
    };
    const payload = renderWebhookTemplate(row.body_template,values);
    const sent = await sendWebhookRequest(row,payload);
    const attempts = Number(row.attempt_count||0)+1;
    const maxAttempts = Number(row.retry_count||0)+1;
    if (sent.ok) {
      await env.DB.prepare(`
        UPDATE heartbeat_notification_logs SET status='sent',attempt_count=?,http_status=?,
          response_body=?,error_message=NULL,sent_at=?,updated_at=? WHERE id=?
      `).bind(attempts,sent.http_status,sent.response_body,now,now,row.id).run();
    } else {
      const delays = WEBHOOK_RETRY_DELAYS;
      const retry = attempts < maxAttempts ? new Date(Date.now()+(delays[Math.min(attempts-1,delays.length-1)]||3600)*1000).toISOString() : null;
      await env.DB.prepare(`
        UPDATE heartbeat_notification_logs SET status='failed',attempt_count=?,http_status=?,
          response_body=?,error_message=?,next_retry_at=?,updated_at=? WHERE id=?
      `).bind(attempts,sent.http_status,sent.response_body,sent.error_message,retry,now,row.id).run();
    }
  }
}

function renderWebhookTemplate(template, values) {
  const rendered = template.replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => {
    const value = values[key.toLowerCase()];

    return value === undefined || value === null ? "" :
      String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
  });

  // Heartbeat devices have no network target address. Remove the target
  // property from JSON payloads rather than sending an empty target field.
  if (values.is_heartbeat === true) {
    try {
      const payload = JSON.parse(rendered);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        delete payload.target;
        return JSON.stringify(payload, null, 2);
      }
    } catch {
      // Preserve non-JSON custom templates as rendered.
    }
  }
  return rendered;
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
    created_at: await formatTimestampForTimezone(new Date().toISOString(), env),
    status_icon: "🔴",
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
    created_at: await formatTimestampForTimezone(row.event_created_at, env),
    status_icon: row.current_status === "DOWN" ? "🔴" : "🟢",
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
// Global application settings
// ==================================================

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

async function getConfiguredTimeZone(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'time_zone'"
  ).first();
  return row?.value || DEFAULT_TIME_ZONE;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim() || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(timeValue, timeZone) {
  if (!timeValue) return "";
  const date = new Date(timeValue);
  if (Number.isNaN(date.getTime())) return String(timeValue);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
  }).formatToParts(date);
  const part = Object.fromEntries(parts.map(item => [item.type,item.value]));
  return part.year + "-" + part.month + "-" + part.day + " " +
    part.hour + ":" + part.minute + ":" + part.second;
}

async function formatTimestampForTimezone(timeValue, env) {
  return formatTimestamp(timeValue, await getConfiguredTimeZone(env));
}

async function getGlobalSettings(env) {
  return json({success:true,settings:{time_zone:await getConfiguredTimeZone(env)}});
}

async function updateGlobalSettings(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({error:"Invalid JSON"},400); }
  const timeZone = body?.time_zone;
  if (!isValidTimeZone(timeZone)) return json({error:"time_zone must be a valid IANA time zone"},400);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES ('time_zone',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `).bind(timeZone,now).run();
  return json({success:true,settings:{time_zone:timeZone}});
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
