# 重建版 API 核验

日期：2026-10-20。当前只核验官方文档和模拟接口契约，**没有真实 Key，未做真实账户调用或样图质量验证**。

| 环节         | 固定接口                                            | 能力边界                                                                      |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 设计盘点     | DeepSeek `deepseek-flash`，`POST /chat/completions` | 图片输入，结构化文字输出；不能替代像素蒙版或修复图                            |
| 连接检查     | DeepSeek `GET /models`                              | 校验账户访问和所需模型是否存在，不证明业务图片质量                            |
| 像素分割     | fal `fal-ai/sam-3/image`                            | 提示框/点/文字生成真实 mask；粗框不能直接当 mask                              |
| 水印局部修复 | fal `fal-ai/object-removal/mask`                    | 使用白色修复区、固定 best_quality、mask_expansion=0；后端再次约束实际合成范围 |
| 排队与取消   | fal queue submit/status/result/cancel               | 使用官方返回的队列路径；提交失败不重复付费重试                                |

官方依据：[DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[视觉输入](https://api-docs.deepseek.com/guides/vision/)、[对话接口](https://api-docs.deepseek.com/api/create-chat-completion/)、[SAM 3](https://fal.ai/models/fal-ai/sam-3/image/api)、[蒙版修复](https://fal.ai/models/fal-ai/object-removal/mask/api)、[fal 队列](https://fal.ai/docs/documentation/model-apis/inference/queue)。

实现、输入输出限制、下载白名单、费用预留与取消边界详见 [适配器说明](../server/providers/README.md)。共享 Key 仅存在服务端，浏览器不直接调用供应商。旧版纯前端配置、自定义地址、本地试提取和示例视觉测试入口已移除。

实际需要验证：密集拼图完整设计召回、水印笔画定位、SAM 对卡通与文字的像素边缘、修复失真、真实收费与预留金额关系。任何模拟测试通过都不能替代这些检查。
