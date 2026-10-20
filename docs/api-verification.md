# DeepSeek API 核验记录

核验日期：2026-10-20（北京时间）。本次依据官方 API 文档；没有 API Key，未发出真实模型调用。文档核验与账号实测是两件事。

## 已有官方证据

| 项目     | 已验证内容                                                                                                                | 官方来源                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 模型名称 | 2026-10-17 更新的 DeepSeek-V4.1-Flash-1017，API 调用仍使用 `deepseek-flash`                                               | [更新日志](https://api-docs.deepseek.com/zh-cn/updates/)              |
| API 基址 | 文档示例使用 `https://api.deepseek.com`                                                                                   | [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)        |
| 连接检查 | `GET /models`，顶层 `object: "list"` 与 `data` 数组；模型项含 `id`、`object: "model"`、`owned_by`                         | [获取模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models/)  |
| 图像理解 | `deepseek-flash` 允许文字与图片输入；支持 JPEG、PNG、GIF、WebP                                                            | [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)        |
| 视觉请求 | `POST /chat/completions`，`messages[].role = "user"`，`content` 数组含 `text` 与 `image_url` 块；图片可用 Base64 data URL | [对话补全](https://api-docs.deepseek.com/api/create-chat-completion/) |

用户原始模型 ID `deepseekv4.1flash1017` 保留为初始值，但官方资料没有将这一连续字符串列为 API 模型 ID。设置界面可主动采用文档推荐的 `deepseek-flash`；连接测试通过模型列表验证当前填写值，不静默替换。模型列表中出现某模型只代表接口列出了它，不能据此断言像素级图像编辑能力。

## 尚未证实的能力

本次所核验的官方页面没有给出水印修复图像返回接口，或按角色返回逐像素分割 mask 的接口。这里的结论是“尚未证实、第一版未接入”，不是“DeepSeek 永远不支持这些能力”。可描述图片、返回文字或框坐标，并不能替代透明 PNG 所需的真实像素 mask。

`API_CAPABILITIES.visionVerified = true` 指官方 `deepseek-flash` 图像理解请求格式已核验。`imageEditingVerified = false` 指图像修复和精确角色分割尚未获得可实现的接口证据。自定义兼容地址是否接受该格式仍须用户实测，官方文档不为第三方网关提供保证。

## 第一版实现边界

- `new DeepSeekProvider(settings).testConnection(signal?)` 返回 `{ models, selectedModelAvailable }`；只读模型列表对网络、超时、429 和部分 5xx 最多重试一次，间隔 500 毫秒。格式错误和鉴权失败不重试。
- `testVision(imageDataUrl, signal?)` 返回 `{ message }`；要求 `allowImageUpload = true`，且当前模型为已核验的 `deepseek-flash`。调用方必须在每次调用前展示可取消的图片外发确认框，说明发送的图片与目标地址。连接测试无需图片，也不上传图片。
- 视觉 POST 不自动重试，避免失败时重复产生计费请求。测试只用于观察实际返回文字，不会伪装为水印修复或角色分割。
- `DEFAULT_SETTINGS.apiKey` 为空。Provider 只在内存保存传入设置；不输出日志、不存储 Key、不回显原始 HTTP 错误正文。请求禁止重定向、浏览器凭证和 referrer；Key 只发送至用户明确配置的基址。
- 基址只接受 HTTPS，或本机 `localhost` / `127.0.0.1` / `::1` 的 HTTP；拒绝带用户名、密码、查询参数及片段的地址。浏览器直连可能受服务方 CORS 策略限制，需在真实账号环境测试。
- 本应用将视觉测试图片限制为 10 MiB，比文档的单张内联图片限制更小；只接受 Base64 图片。用户不必把真实业务素材用于连接检查。
- `WatermarkRepairProvider` 输入原图和真实 `PixelMask`，输出修复后的 `Raster`；`CharacterSegmentationProvider` 返回每个实例的真实 `PixelMask`。未配置实现直接报错，不返回原图冒充处理成功，不将矩形框当作精确 mask。

## 已有自动测试

使用 mock fetch 覆盖连接 schema、原始模型 ID 保留、Key 不经重定向、鉴权失败不泄露、有限重试、超时、取消、地址校验、外发开关、模型格式限制、视觉请求结构、视觉 POST 不自动重试，以及未接入 provider 明确失败。测试不使用真实 Key、不调用外部接口、不证明真实账号的端到端可用性。
