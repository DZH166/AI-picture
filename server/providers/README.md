# 服务端模型适配器

仅服务端导入。构造器为 `(key, reserve, options?)`，第三参数可传 `fetch` 替身，或 `{fetchImpl,requestTimeoutMs,queueTimeoutMs,pollIntervalMs}`。预算回调错误原样传播；外部取消使用 `AbortError`。不打印 Key、原始错误或模型响应。

核验于 2026-10-20，依据实际打开的官方文档：

- https://api-docs.deepseek.com/api/list-models/ — GET /models；模型 ID `deepseek-flash`。
- https://api-docs.deepseek.com/api/create-chat-completion/ — POST /chat/completions，JSON object、thinking disabled、文本响应。
- https://api-docs.deepseek.com/guides/vision/ — image_url data URI、detail original。接口输出文本；本应用要求模型在文本 JSON 中报告粗框，这不是官方保证的定位精度或像素 mask。
- https://fal.ai/models/fal-ai/sam-3/image/api — SAM 3 的 point_prompts、box_prompts、apply_mask=false、masks/ scores。
- https://fal.ai/models/fal-ai/object-removal/mask/api — mask_url，白色表示修复区域；best_quality、mask_expansion。
- https://fal.ai/docs/documentation/model-apis/inference/queue — POST submit；使用服务端返回的 owner/app 路径 status/response/cancel URL（不是完整endpoint路径）；GET状态/结果；PUT取消；X-Fal-No-Retry。
- https://fal.ai/docs/documentation/model-apis/fal-cdn — 输出位于 fal.media、v3.fal.media、v3b.fal.media。下载不携带Key；只允许HTTPS、固定host、禁止重定向，流式限制30MiB。
- https://fal.ai/docs/documentation/model-apis/common-parameters — 禁用平台自动重试及模型 fallback；关闭请求历史载荷存储；通过生命周期 header 请求生成媒体在 3600 秒后过期。

DeepSeek 每张执行完整原图和2×2复核：每块宽高为原图的60%，相邻块重叠原图宽高的20%，共5次POST，每次预留0.15元。粗框按每块局部像素校验，再映射回原图、去重。矩形海报不拆内部人物；保留文字/徽章完整设计。水印与设计文字通过提示词区别，低置信候选保留警告。文档虽接受 detail=original，同时说明推理前仍会按像素规模缩放，大图约缩到1300×1300像素量；因此密集小人物可能漏检，识别精度、去重效果仍需真实业务图验收。

SAM每次预留0.05元；修复固定best_quality，每次预留0.20元。预留金额是应用保护额度，不是官方最终结算，也不能保证实际账单低于此金额。预算拒绝时不提交，错误原样传回。预留成功之后即使网络失败或取消也不自动冲销，以免对已执行的请求重复开放额度。POST失败不会重复提交。队列超时180秒会尽力取消，但上游已执行的请求可能仍完成和计费；若submit响应丢失则无法取得取消URL，应核对服务商记录。取消本地HTTP等待本身不等于取消上游推理；调用方须将AbortSignal传入服务，才能触发尽力队列取消。

输入及输出mask必须是实际像素图片。SAM mask会将透明区域按黑色处理，再二值化并按原图尺寸做最近邻缩放，仅允许宽高比误差≤1.5%；不从粗框制造mask。不保证模型内部没有letterbox或视觉错位，需要结果复核。修复输出仅接受相同比例并映射回输入尺寸。下载限制30MiB、解码40MP。

fal生成文件默认可能通过持有URL直接访问。当前请求设置一小时媒体过期偏好，关闭请求历史载荷存储；这不等于零数据留存，也不控制模型部署方自己的日志。应用不会向员工返回fal媒体URL，下载后使用本地带会话校验的地址提供结果。云端留存与实际删除行为仍需依据服务方政策和真实账户设置核验。

适配器测试均使用mock HTTP，不用真实凭据。本地测试通过不等于真实账号或业务图片的模型效果已验收。
