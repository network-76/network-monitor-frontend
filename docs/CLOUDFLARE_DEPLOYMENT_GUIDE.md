# Cloudflare 部署指南（新手版）

本文说明如何把本项目部署到 Cloudflare，包含网页、后台 Worker、D1 数据库、Globalping API、定时任务和后续更新。按顺序操作即可。

> 本项目不是只上传一个 HTML 文件就能运行。它由前端网页、Cloudflare Worker 后端、D1 数据库和 Worker 定时任务组成。
>
> 本指南针对当前代码结构编写。当前后台入口文件为 `work/work_v1.5.js`，前端入口为仓库根目录的 `index.html`。

---

## 一、先了解部署结构

| 组成 | 用途 | 项目中的位置 |
|---|---|---|
| Cloudflare Pages | 托管管理网页 | `index.html` |
| Cloudflare Worker | 提供 API、执行监控调度和告警 | `work/work_v1.5.js` |
| Cloudflare D1 | 保存监控对象、测量结果、心跳设备、Webhook 等数据 | 数据库绑定名为 `DB` |
| Globalping | 提供全球网络探测节点和 Ping 测量能力 | 外部 API |
| Worker Cron Trigger | 定时执行探测、结果轮询和告警处理 | Worker 的定时触发器 |

**重要：** 本仓库已经包含 Pages Functions 代理文件 `functions/api/[[path]].js`。Pages 将 `/api/*` 请求交给该函数，由函数读取 Pages 环境变量并转发到 Worker Custom Domain。新部署时必须保留该文件及仓库根目录的 `functions` 目录；不需要另外创建 Worker Route 来实现这条代理。

---

## 二、部署前准备

请先准备：

1. 一个 Cloudflare 账号：<https://dash.cloudflare.com/>
2. 一个 GitHub 账号，并能访问本项目仓库：<https://github.com/network-76/network-monitor-frontend>
3. 一个 Globalping 账号及 API Token：<https://www.globalping.io/>
4. 一个电脑浏览器，建议使用 Chrome 或 Edge。

### 2.1 获取 Globalping Token

1. 打开 Globalping 网站并登录。
2. 进入账户中管理 API Token 的页面。
3. 创建一个 API Token。
4. 复制 Token，暂时保存在安全的地方。

Token 相当于密码，不要发到群聊、不要提交到 GitHub，也不要写进 `index.html`。

### 2.2 生成 Worker 所需密钥

本项目 Worker 需要配置三个 Secret，名称必须完全一致：

| Secret 名称 | 用途 | 获取方式 |
|---|---|---|
| `GLOBALPING_TOKEN` | 调用 Globalping API，创建探测任务、查询探测节点和测量结果 | 在 Globalping 账户中创建并复制 API Token |
| `MONITOR_API_KEY` | 管理 API 的访问鉴权，前端管理请求通过 `X-Monitor-Key` 请求头携带 | 在本地电脑使用 OpenSSL 随机生成 |
| `HEARTBEAT_TOKEN_ENCRYPTION_KEY` | 使用 AES-256-GCM 加密保存心跳设备 Token，以便管理界面重新显示心跳 URL | 在本地电脑使用 OpenSSL 生成 32 字节随机密钥，再进行 Base64 编码 |

#### 生成 MONITOR_API_KEY

在 Linux、macOS、WSL 或安装了 OpenSSL 的 Windows 终端执行：

```bash
openssl rand -hex 32
```

命令会输出一串 64 位十六进制随机字符串。复制完整输出，作为 `MONITOR_API_KEY` 的值。

#### 生成 HEARTBEAT_TOKEN_ENCRYPTION_KEY

在终端执行：

```bash
openssl rand -base64 32
```

命令会输出一段 Base64 字符串。复制完整输出，作为 `HEARTBEAT_TOKEN_ENCRYPTION_KEY` 的值。

**这个命令生成的是 32 字节随机数据的 Base64 编码，符合当前 Worker 源码的要求。** Worker 会对该值进行 Base64 解码，并要求解码后长度必须正好是 32 字节；不能把上面两个命令生成的值互换。

#### GLOBALPING_TOKEN

这个值不是本项目本地生成的密钥。登录 Globalping 账户，在 API Token 管理页面创建并复制 Token。

#### 重要注意事项

- 两个 OpenSSL 命令都在你自己的电脑终端执行，不是在 Cloudflare D1 Console 或 Worker 在线编辑器中执行。
- 每次生成都会得到不同的随机值。生成后立即复制并妥善保存。
- 不要把任何 Secret 提交到 GitHub，也不要写入 `index.html` 或 Worker 源码。
- `HEARTBEAT_TOKEN_ENCRYPTION_KEY` 尤其重要：**正式使用后不要随意重新生成或更换**。数据库中的心跳设备 Token 密文依赖原密钥解密；更换密钥后，旧密文将无法解密，已有设备的原心跳 URL 也可能无法重新取回。若密钥遗失，同样无法解密旧密文。

---

## 三、创建 D1 数据库

D1 用来保存监控系统的数据。

1. 登录 Cloudflare Dashboard。
2. 左侧进入 **Workers & Pages**，再找到 **D1**（部分界面也可通过左侧 Storage & databases 进入）。
3. 点击 **Create database**。
4. 数据库名称建议填写：`network-monitor-db`。
5. 点击创建。
6. 打开刚创建的数据库，记下数据库名称，后面绑定 Worker 时要选择它。

### 3.1 初始化数据库（全新部署只执行这一份 SQL）

本项目已经提供**完整数据库初始化文件**：

- 文件：[`database/schema.sql`](https://github.com/network-76/network-monitor-frontend/blob/main/database/schema.sql)

该文件包含当前版本所需的全部业务表、字段、主键、唯一约束、外键、索引，以及默认时区 `Asia/Shanghai`。它是完整建库脚本，不是追加迁移脚本。

按以下步骤操作：

1. 在 D1 页面打开刚创建的 `network-monitor-db`。
2. 进入 **Console**。
3. 打开 GitHub 上的 [`database/schema.sql`](https://github.com/network-76/network-monitor-frontend/blob/main/database/schema.sql) 文件。
4. 复制文件中的全部 SQL（从第一行到最后一行）。
5. 粘贴到 D1 Console，执行。
6. 确认执行成功，没有 SQL 错误。

**全新数据库只需要执行 `database/schema.sql` 一次。不要再执行 `migrations/0003_global_time_zone.sql` 或 `migrations/0004_soft_delete_monitors.sql`。** 这两个文件所代表的当前结构已经包含在完整初始化文件中：默认时区记录已写入，`monitors.deleted_at` 字段也已包含。

注意：

- `_cf_KV` 是 Cloudflare 内部管理的表，不需要也不允许由本项目手动创建。
- 本 SQL 面向新建的空 D1 数据库。不要在已有业务数据的数据库上重复执行，否则会因为表已存在而报错。
- 如果是已有数据库，不要重新初始化；继续使用该数据库现有结构。
- 后续代码版本若新增数据库结构变更，再按该版本明确提供的升级说明执行对应变更；这与首次建库使用的完整 SQL 是两回事。

---

## 四、部署后台 Worker

Worker 负责 API、探测调度、结果轮询、心跳离线判断和 Webhook 通知。

### 4.1 创建 Worker

1. Cloudflare Dashboard → **Workers & Pages**。
2. 点击 **Create application**。
3. 选择 **Create Worker**。
4. Worker 名称建议填写：`network-monitor-api`。
5. 点击部署，先创建一个 Worker。
6. 进入 Worker 的代码编辑页面。

### 4.2 上传项目 Worker 代码

1. 在 GitHub 打开本项目：<https://github.com/network-76/network-monitor-frontend>
2. 进入 `work/work_v1.5.js`。
3. 打开 Raw 或下载文件，取得完整源码。
4. 在 Cloudflare Worker 编辑器中，用完整文件内容替换编辑器里的示例代码。
5. 保存并部署。

不要只复制文件的一部分；必须复制从第一行到最后一行的完整内容。

### 4.3 配置 D1 绑定

1. 打开刚创建的 Worker。
2. 进入 **Settings** → **Bindings**。
3. 点击 **Add**，选择 **D1 database**。
4. Variable name（变量名）填写：`DB`。
5. Database 选择第三步创建的 `network-monitor-db`。
6. 保存绑定。

变量名必须准确写成大写 `DB`，因为 Worker 源码通过 `env.DB` 访问数据库。

### 4.4 配置三个运行时 Secret

在 Worker 的 **Settings** → **Variables and Secrets** 中，添加以下三个 Secret：

| Secret 名称 | 类型 | 填入的值 |
|---|---|---|
| `GLOBALPING_TOKEN` | Secret | 第二步从 Globalping 获取的 API Token |
| `MONITOR_API_KEY` | Secret | 第二步使用 `openssl rand -hex 32` 生成的 64 位十六进制字符串 |
| `HEARTBEAT_TOKEN_ENCRYPTION_KEY` | Secret | 第二步使用 `openssl rand -base64 32` 生成的 Base64 字符串 |

操作方式：

1. 打开 Worker → **Settings** → **Variables and Secrets**。
2. 点击添加变量，类型选择 **Secret**。
3. 按表格逐个填写 Secret 名称和值，注意名称大小写和下划线。
4. 保存三个 Secret。
5. 如果 Cloudflare 提示变量更新后需要重新部署，请按页面提示部署新版本。

三个值的用途不同，不能互相替代。尤其不要把 `HEARTBEAT_TOKEN_ENCRYPTION_KEY` 当作普通管理密钥使用，也不要在系统运行后随意更换它。

**不要把这三个值写进 Worker 源码、前端 HTML 或 GitHub 仓库。**

### 4.5 配置 Worker 定时任务（Cron Trigger）

本项目 Worker 除了接收网页请求，还需要定时运行后台任务。没有 Cron Trigger，自动探测调度、测量结果轮询以及定时告警处理可能不会正常运行。

1. 打开 Worker。
2. 找到 **Settings** → **Triggers**（部分界面会把 Cron 放在 Triggers 页面）。
3. 找到 **Cron Triggers**。
4. 点击添加 Cron。
5. 建议先配置：`*/1 * * * *`（每分钟执行一次）。
6. 保存。

Cron 表达式含义：每分钟触发一次。不要把它设置成每秒执行；Cloudflare Cron 使用五段式表达式。

### 4.6 记录 Worker 地址

部署后 Cloudflare 会提供一个 Worker 域名，通常类似：

`https://network-monitor-api.<你的账户子域>.workers.dev`

请复制并保存这个地址。后续需要将网站的 `/api/*` 请求转发到这个 Worker。

---

## 五、部署前端 Pages

前端是一个静态网页，入口文件是仓库根目录的 `index.html`。

### 5.1 创建 Pages 项目

1. Cloudflare Dashboard → **Workers & Pages**。
2. 点击 **Create application**。
3. 选择 **Pages**，再选择 **Connect to Git**。
4. 授权 Cloudflare 访问 GitHub。
5. 选择仓库：`network-76/network-monitor-frontend`。
6. 选择生产分支：`main`。

### 5.2 配置构建参数

本项目是静态 HTML 页面，并通过仓库中的 Pages Functions 提供 API 代理；不需要 npm、Node.js 或前端打包。

建议配置：

| 配置项 | 填写值 |
|---|---|
| Framework preset | None（无框架） |
| Build command | 留空 |
| Build output directory | `/` |
| Root directory | 留空或保持仓库根目录（如果页面提供此选项） |

然后点击 **Save and Deploy**。

部署成功后，Cloudflare 会分配一个 Pages 域名，通常类似：

`https://<项目名称>.pages.dev`

打开该地址，应该能看到“网络监控管理系统”页面。


### 5.3 配置 Pages 项目的环境变量和密钥（重要）

除了 Worker 中配置的三个 Secret，**Cloudflare Pages 项目本身也需要配置两个变量**。这两个配置属于 Pages 项目，不要误填到 Worker 的 Variables and Secrets 中。

进入 Cloudflare Dashboard → **Workers & Pages** → 选择 Pages 项目 `network-monitor-frontend` → **Settings** → **Environment variables**（不同版本界面可能显示为 Variables and Secrets），在 **Production** 环境中添加：

| 名称 | 类型 | 值 | 说明 |
|---|---|---|---|
| `MONITOR_API_KEY` | Secret（密钥） | 与 Worker 中 `MONITOR_API_KEY` 完全相同 | Pages 侧调用后端 API 时使用的管理 API 密钥 |
| `MONITOR_API_URL` | Text（文本） | `https://network.monitoruptime.kdns.fr` | 后端 Worker API 的基础地址 |

配置步骤：

1. 打开 Pages 项目 `network-monitor-frontend`。
2. 进入 **Settings**，找到 **Environment variables** 或 **Variables and Secrets**。
3. 在 **Production** 环境下添加 `MONITOR_API_KEY`，类型选择 **Secret**，值填写 Worker 项目中配置的同一个 `MONITOR_API_KEY`。
4. 添加 `MONITOR_API_URL`，类型选择 **Text**，值填写当前后端 API 地址：`https://network.monitoruptime.kdns.fr`。
5. 保存配置。
6. 变量新增或修改后，重新部署 Pages（可在 **Deployments** 中对最新生产部署执行 Retry deployment，或提交一次代码变更触发新部署），使新配置应用到部署环境。

**注意区分 Pages 与 Worker 的变量：**

- Worker 仍需配置三个 Secret：`GLOBALPING_TOKEN`、`MONITOR_API_KEY`、`HEARTBEAT_TOKEN_ENCRYPTION_KEY`。
- Pages 另需配置上表中的两个变量：`MONITOR_API_KEY` 和 `MONITOR_API_URL`。
- 两处的 `MONITOR_API_KEY` 是同一个管理 API 密钥，值必须完全一致；不要为 Pages 再生成一个不同的密钥。
- `MONITOR_API_URL` 是后端 API 服务地址，不是 Pages 自身的网址；如果更换 Worker 的自定义域名或 API 入口，应同步更新此值。
- `MONITOR_API_KEY` 必须使用 Secret 类型，不要使用 Text，也不要把密钥写入 GitHub 仓库或前端源码。
- 本项目当前只使用 Production，不使用 Preview 部署；因此只需配置 Production 环境变量。不要把本指南中的步骤理解为还需要额外创建 Preview 环境。

### 5.4 配置 Pages 到 Worker 的 API 转发（非常重要）

当前前端通过同源相对路径请求 API，例如 `/api/monitors`。仓库已经提供 Pages Functions 代理文件：

- 文件：`functions/api/[[path]].js`
- 路由：匹配 Pages 域名下的 `/api/*`。
- 环境变量：读取 Pages Production 的 `MONITOR_API_URL` 和 `MONITOR_API_KEY`。
- 转发行为：将请求转发到 `MONITOR_API_URL` 下的 `/api/{path}`，并自动添加 `X-Monitor-Key` 请求头。

**全新部署必须使用仓库根目录作为 Pages 项目目录，并保留 `functions/api/[[path]].js`。** 不要只上传 `index.html`，也不要删除 `functions` 目录。Pages Functions 会随 Pages 项目一起部署，不需要另建 Worker Route 或在 HTML 中写入 Worker 地址。

本项目的 `MONITOR_API_URL` 应填写 Worker Custom Domain 的根地址：

```text
https://network.monitoruptime.kdns.fr
```

不要在末尾添加 `/api` 或具体接口路径；Pages Function 会自行拼接 `/api/{path}`。Worker Custom Domain 应绑定到本项目的 Worker。


### 5.5 配置 Cloudflare Access 邮件 PIN 登录（重要）

本项目管理网页使用 Cloudflare Access 保护。用户打开管理页面时，需要输入获准邮箱地址，Cloudflare 会向该邮箱发送一次性 PIN 码；输入正确 PIN 后才能进入系统。

本项目当前使用的 Pages 域名和策略配置如下：

| 配置项 | 当前配置 |
|---|---|
| Access 应用类型 | Self-hosted |
| 应用公共主机名 | `network-monitor-frontend.pages.dev` |
| Access 策略名称 | `Allow My Email` |
| 策略动作 | `Allow` |
| 策略规则 | `Include → Emails → 指定允许登录的邮箱` |
| 会话持续时间 | `24 hours` |
| 登录方式 | `One-time PIN`（邮件一次性 PIN） |

#### 第一步：启用 One-time PIN 登录方式

1. 登录 Cloudflare Dashboard。
2. 进入 **Zero Trust**。
3. 打开 **Integrations** → **Identity providers**。
4. 在身份提供程序列表中查看是否已有 **One-time PIN**。
5. 如果没有，点击 **Add new identity provider**。
6. 选择 **One-time PIN**，按页面提示添加并保存。

注意：新建的 Zero Trust 组织不一定默认启用 One-time PIN，需要手动添加。当前账户如果已经显示 One-time PIN 已添加，不要重复创建。

官方说明：[Cloudflare One-time PIN 登录文档](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

#### 第二步：配置 Access 应用

1. 在 Zero Trust 中进入 **Access** → **Applications**。
2. 找到已经创建的管理网站应用；如果尚未创建，点击 **Add an application**。
3. 应用类型选择 **Self-hosted**。
4. 应用名称可填写：`Network Monitor`。
5. Public hostname 填写：`network-monitor-frontend.pages.dev`。
6. 确认应用的登录身份提供程序中包含 **One-time PIN**。
7. 当前账户还勾选了 **Cloudflare** 身份提供程序；如果保留该选项，登录页面也可能提供 Cloudflare 登录方式。如果只希望用户使用邮件 PIN，则只允许 One-time PIN。
8. 会话持续时间设置为 `24 hours`。
9. 保存应用配置。

如果应用已经存在，不要重复创建；检查并调整现有应用即可。

#### 第三步：配置允许登录的邮箱策略

在该 Access 应用的 **Policies** 中添加或检查以下策略：

| 配置项 | 设置值 |
|---|---|
| Policy name | `Allow My Email` |
| Action | `Allow` |
| Rule type | `Include` |
| Selector | `Emails` |
| Value | 填写实际允许登录的邮箱地址 |

操作步骤：

1. 打开 Access 应用的 **Policies**。
2. 新建策略，名称填写 `Allow My Email`。
3. Action 选择 **Allow**。
4. 添加一条规则：**Include** → **Emails**。
5. 输入允许登录的完整邮箱地址。
6. 保存策略，并确认它已经关联到 `network-monitor-frontend.pages.dev` 这个应用。

One-time PIN 是身份验证方式，`Allow My Email` 是访问授权策略，两者不是同一个功能。用户通过邮件 PIN 完成身份验证后，Cloudflare Access 还会根据应用策略判断是否允许访问；不在 Include 邮箱名单中的用户不能获得应用访问权限。不要把策略设置成允许所有邮箱。

#### 第四步：为设备心跳接口配置免登录例外

**这一步不能省略。**

设备心跳使用 Worker 的 `/api/push/{设备Token}` 接口。请注意：当前 Worker 在创建心跳设备时，会根据 Worker 收到请求的 URL 生成完整心跳 URL；由于 Pages Function 将管理 API 转发到 Worker Custom Domain，实际生成的心跳 URL 使用 Worker Custom Domain（当前为 `network.monitoruptime.kdns.fr`），而不是 Pages 域名。

因此，Pages 域名上的 `/api/push/*` Bypass 只影响通过 Pages 域名访问的心跳请求；它不会自动作用于 Worker Custom Domain。当前 Worker Custom Domain 不应再被另一个 Access 应用要求邮件登录，否则设备无法直接上报。

因此，需要为心跳上报路径单独配置一个优先级更高的公开访问例外：

1. 在 **Zero Trust** → **Access** → **Applications** 中，新增一个 Self-hosted 应用。
2. 应用名称填写：`Network Monitor Heartbeat Push`。
3. Public hostname 填写：`network-monitor-frontend.pages.dev`。
4. Path 填写：`/api/push/*`。
5. 为该路径配置 **Bypass** 策略，规则选择 **Include → Everyone**。
6. 保存。

该路径级应用只对 Pages 主机名下的 `/api/push/*` 生效。保留你当前已配置的独立 Self-hosted 应用和 Bypass + Everyone 策略即可。它可使通过 Pages 域名访问的心跳路径免于邮件 PIN，但**不能替代对 Worker Custom Domain 的检查**。

**重要：** 设备实际使用系统生成的完整心跳 URL。确认 URL 的主机名是 `network.monitoruptime.kdns.fr`，并确认该 Worker Custom Domain 没有被其他 Access 应用保护。如果它被 Access 登录保护，必须调整该域名的访问策略，否则 AC 的 GET 心跳请求会被拦截。

**安全边界：** Bypass 只表示不要求 Cloudflare 邮件 PIN，不代表心跳接口没有鉴权。Worker 的 `/api/push/{token}` 仍会通过数据库中的 Token 哈希校验设备身份；不要删除或绕过 Worker 的 Token 校验逻辑。管理 API 则仍需 Worker 管理密钥鉴权。

#### 第五步：验证邮件 PIN 登录和心跳上报

**验证网页登录：**

1. 使用浏览器无痕窗口打开：
   `https://network-monitor-frontend.pages.dev`
2. 页面应跳转到 Cloudflare Access 登录界面。
3. 输入策略中允许的邮箱地址。
4. 点击发送登录码。
5. 检查邮箱，找到 Cloudflare 发来的 PIN。
6. 将 PIN 输入登录页面。
7. 验证是否成功进入网络监控管理页面。

**验证未授权邮箱：**

使用不在 `Allow My Email` 策略中的邮箱测试。该邮箱不应获得应用访问权限，也不会收到有效登录 PIN。

**验证 AC 心跳：**

1. 在管理页面创建测试心跳设备并复制完整 URL。
2. 检查 URL 主机名是否为 `network.monitoruptime.kdns.fr`。
3. 从 AC 或其他设备执行 GET 请求。
4. 请求应直接到达 Worker，不应跳转到 Cloudflare Access 登录页面；成功时应返回 JSON，设备状态和最近心跳时间应更新。
5. 如果返回 401，检查设备 Token；如果返回 Access 登录页面，检查该 URL 所属主机名是否被 Access 保护。

#### PIN 登录的几个注意事项

- PIN 是一次性使用的验证码，成功使用后不能重复使用。
- PIN 自首次请求起 10 分钟后过期。
- 重新申请 PIN 会使之前的 PIN 失效。
- 如果邮箱收不到 PIN，先检查邮箱地址是否命中 `Allow My Email` 策略，再检查垃圾邮件和邮件网关。
- 如果邮件安全系统自动扫描并消费了验证码链接，可能出现 PIN 已使用的提示；可重新申请 PIN，并将 `noreply@notify.cloudflare.com` 加入邮件安全扫描白名单。

官方参考：
- [One-time PIN 登录配置与行为](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Access 邮箱策略配置示例](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
- [Cloudflare Access 路径级保护说明](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

---

## 六、首次部署检查

部署完成后，按以下顺序检查。

### 6.1 检查网页与 Access 登录

先在无痕窗口打开 Pages 域名，确认 Cloudflare Access 邮件 PIN 登录正常；成功登录后再检查网页：

- 页面能正常显示；
- 浏览器没有明显的 JavaScript 错误；
- 各个卡片可以正常显示。

### 6.2 检查数据库连接

在浏览器中访问：

`https://<网站域名>/api/db/test`

注意：该接口受 `MONITOR_API_KEY` 管理密钥保护。直接在浏览器地址栏访问通常不会自动携带管理请求头，因此出现 401 不一定代表数据库故障。

更可靠的检查方式是在 Worker 的 Logs 中查看请求错误，或使用能添加 `X-Monitor-Key` 请求头的 API 测试工具进行检查。

成功时接口返回 JSON，包含 `success: true` 和数据库表名列表。

### 6.3 检查监控页面数据

在管理页面检查：

- 监控总览数据是否能加载；
- 监控对象列表是否正常；
- 心跳设备列表是否正常；
- Webhook 配置和告警通知记录是否能加载；
- 时区切换后时间是否立即更新。

如果页面提示 401，优先检查管理 API 鉴权配置及当前站点到 Worker 的请求转发，不要把管理密钥写进前端页面。

### 6.4 检查 Globalping 探测

在页面中创建一个测试监控对象，填写目标 IP 或域名，配置探测地区代码，然后观察测量是否能正常完成。

如果出现 `GLOBALPING_TOKEN missing`，说明 Worker 没有正确配置 `GLOBALPING_TOKEN` Secret。

如果 Globalping 返回鉴权错误，检查 Token 是否复制完整、是否仍有效。

### 6.5 检查心跳设备

1. 在心跳设备卡片中添加一个测试设备。
2. 复制系统生成的心跳 URL。
3. 在能访问公网的 Linux 设备上执行：

```bash
curl -i "将这里替换为系统生成的完整心跳URL"
```

心跳协议是 GET 请求，不需要额外 Header，也不需要 Body。

注意：心跳 URL 中包含设备 Token，应按密码管理，不能公开分享。测试成功后，页面中应能看到最近心跳时间和在线状态。

### 6.6 检查 Cron

1. 打开 Worker 的 Logs。
2. 等待至少一到两个 Cron 周期。
3. 检查是否出现 Cron 执行记录。
4. 如果没有执行记录，检查 Cron Trigger 是否保存到了当前正在使用的 Worker 环境。

---

## 七、后续如何更新系统

日常开发更新通常只需要更新 GitHub 仓库文件。

### 7.1 只修改了前端

例如只修改 `index.html`：

1. 将新代码提交到 GitHub 的 `main` 分支。
2. Cloudflare Pages 会自动开始部署。
3. 等待部署状态变为 Success。
4. 浏览器强制刷新页面（Windows：Ctrl + F5）。

不需要重新部署 Worker，也不需要执行数据库迁移。

### 7.2 修改了 Worker

例如修改 `work/work_v1.5.js`：

1. 在 GitHub 提交最新 Worker 代码。
2. 打开 Cloudflare Worker 编辑页面。
3. 将完整最新源码复制到 Worker 编辑器。
4. 保存并部署。
5. 检查 Worker Logs 是否有运行错误。

如果项目后续改为 Git 集成自动部署 Worker，则按对应自动部署流程操作；在没有确认自动部署已配置前，不要假设 GitHub 提交会自动更新 Worker。

### 7.3 后续版本涉及数据库结构变化

首次部署新建空数据库时，执行完整的 `database/schema.sql`。**已有运行中的数据库不能再次执行完整初始化文件。**

如果未来版本明确提供新的数据库升级 SQL：

1. 先备份当前 D1 数据库。
2. 阅读该版本发布说明，确认升级 SQL 对应的版本和适用的旧结构。
3. 在正确的 D1 数据库 Console 中执行该版本升级 SQL，且只执行一次。
4. 确认 SQL 成功后，再部署依赖新结构的 Worker 和 Pages 代码。
5. 记录已执行的升级版本，避免重复执行。

不要自行把完整初始化 SQL 当作升级脚本，也不要在没有升级说明时猜测执行迁移文件。

### 7.4 更新顺序速查

| 变更内容 | 需要做什么 |
|---|---|
| 只改 `index.html` | 等待 Pages 自动部署 |
| 只改 Worker JS | 更新并部署 Worker |
| 新增 D1 migration | 先备份，再执行新增 SQL |
| 同时改 Worker 和 D1 | 先执行兼容的数据库迁移，再部署 Worker |
| 同时改前端和 Worker | 分别部署 Pages 和 Worker |

---

## 八、备份与安全建议

### 8.1 定期备份 D1

D1 保存监控对象、测量历史、心跳设备和告警记录。建议定期通过 Cloudflare D1 的导出/备份功能保存数据库副本。

执行数据库结构调整前，先做一次备份。

### 8.2 保护密钥

以下内容属于敏感信息：

- `MONITOR_API_KEY`
- `GLOBALPING_TOKEN`
- 心跳设备 URL 中的 Token
- Webhook URL（可能包含密钥）

不要把这些内容提交到 GitHub、截图公开或发给无关人员。

### 8.3 限制管理页面访问

管理网站通过 Cloudflare Access 的邮件 PIN 登录进行访问控制，允许登录的邮箱由 `Allow My Email` 策略限制；Worker 管理 API 还使用 `MONITOR_API_KEY` 校验请求。两层控制各自独立，不要将其视为可以相互替代。

只有设备心跳上报路径 `/api/push/*` 需要绕过 Access 邮件登录，以便 AC 等设备能够直接上报；该路径仍必须通过 Worker 的设备 Token 校验。不要将其他管理 API 设置为 Bypass。

---

## 九、常见问题

### 1. 页面能打开，但监控列表一直加载失败

优先检查：

- Pages 域名的 `/api/*` 是否正确转发到 Worker；
- Worker 是否部署成功；
- Worker 是否绑定了 D1，绑定变量名是否为 `DB`；
- `MONITOR_API_KEY` 是否配置正确；
- Worker Logs 是否有数据库或鉴权错误。

### 2. 提示 `Unauthorized` 或 HTTP 401

表示 Worker 没有通过管理密钥校验。检查管理请求是否正确携带 `X-Monitor-Key`，以及当前部署是否配置了 `MONITOR_API_KEY`。

不要为了绕过 401 而删除 Worker 的鉴权代码。

### 3. 提示 `DB binding missing` 或数据库相关错误

检查 Worker 的 D1 Binding：

- Variable name 必须是 `DB`；
- 绑定的数据库必须是本项目实际使用的 D1；
- 基础表和所需迁移必须已经执行。

### 4. 提示 `GLOBALPING_TOKEN missing`

在 Worker 的 Variables and Secrets 中添加或检查 `GLOBALPING_TOKEN`，保存后重新部署。

### 5. 页面修改后没有变化

- Pages 部署是否成功；
- 是否部署到了 `main` 分支；
- 浏览器是否仍使用旧缓存；
- 使用 Ctrl + F5 强制刷新。

### 6. 心跳设备一直显示离线

检查设备端是否定时请求系统生成的完整心跳 URL。请求方式必须为 GET，且设备必须能访问该 URL。再查看 Worker Logs 和心跳设备最后心跳时间。

### 7. 告警没有发送

检查：

- 是否创建并启用了 Webhook 配置；
- Webhook 是否订阅了对应 DOWN / UP 事件；
- Webhook URL 是否有效；
- Worker Cron Trigger 是否正常执行；
- Worker Logs 中是否有发送失败或重试记录。

---

## 十、部署完成检查清单

完成后逐项确认：

- [ ] D1 数据库已创建
- [ ] 基础数据库表已初始化
- [ ] 已完整执行 `database/schema.sql`
- [ ] Worker 已部署
- [ ] Worker 已绑定 D1，变量名为 `DB`
- [ ] 已配置 Secret：`GLOBALPING_TOKEN`
- [ ] 已配置 Secret：`MONITOR_API_KEY`
- [ ] 已配置 Secret：`HEARTBEAT_TOKEN_ENCRYPTION_KEY`
- [ ] Cron Trigger 已配置并能正常执行
- [ ] Pages 已连接 GitHub 仓库并部署成功
- [ ] Pages Production 已配置 Secret：`MONITOR_API_KEY`（与 Worker 中的值一致）
- [ ] Pages Production 已配置 Text：`MONITOR_API_URL`（后端 API 基础地址）
- [ ] Pages 变量配置后已重新部署
- [ ] Pages 项目根目录包含 `functions/api/[[path]].js`，Pages Function 已部署
- [ ] `MONITOR_API_URL` 指向 Worker Custom Domain 根地址（不带 `/api`）
- [ ] Cloudflare Access 已启用 One-time PIN 身份提供程序
- [ ] Access 应用已保护 `network-monitor-frontend.pages.dev`
- [ ] `Allow My Email` 策略已关联并限制允许登录的邮箱
- [ ] Access 会话持续时间已设置为 24 hours
- [ ] `/api/push/*` 已设置 Access Bypass 例外，且 Worker Token 校验仍有效
- [ ] 邮件 PIN 登录测试成功
- [ ] 管理页面能正常读取数据
- [ ] Globalping 测试探测成功
- [ ] 心跳设备测试成功
- [ ] Webhook 测试发送成功

完成以上检查后，系统才算部署完成。
