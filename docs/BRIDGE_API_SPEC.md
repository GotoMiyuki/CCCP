# Bridge API 草案

对应 Design Guide §22–25、§29。当前为进程内异步 API，不是已部署的 HTTP / MCP Server。

## 构造与认证

```js
const bridge = new Bridge({
  sessions: [{
    id: sessionId,
    token: opaqueToken,
    actor: authenticatedPrincipal,
    task_id: taskId,
    repository: { path, branch, commit },
    allowed_types: ['REVIEW_RESULT'],
  }],
  routes: {
    REVIEW_RESULT: ({ actor, envelope }) =>
      lifecycleController.applyReview(actor, envelope.payload),
  },
});
const receipt = await bridge.send(opaqueToken, envelope);
```

构造输入来自可信宿主，不能直接由远端调用者填写。Token 与 Human / ChatGPT / Codex 身份的映射在进入 Bridge 前完成；长度检查不替代随机性或真实认证。Bridge 不在审计日志中记录 token。

Session 固定 task、repository snapshot、消息类型授权。刷新 commit 后由宿主创建匹配的新会话，不通过修改消息静默扩大既有 Session。

## Envelope

必须含 `protocol: CCCP`、`version: 1.0`、`message_type`、`message_id`、`task_id`、带时区的 `timestamp`、`repository`、匹配消息类型的 `payload`。

可选 `request_id`、`parent_message_id`、`idempotency_key` 用于相关性、血缘和去重。结构中不接收自报 `actor` 或 `approved`。具体种类在 `MESSAGE_TYPES` 和 Envelope Schema 中定义，共 13 种。

- `DESIGN_DECISION` 仅接受 Human Session。
- Discovery / Implementation Report 仅接受 Codex Session。
- Review 的 `reviewer` 必须等于已认证发送者；R3 要求 ChatGPT / Human。
- 其他消息按参与者与会话 grants 过滤。

接收者仍须执行业务层的状态、审批和 Delegation 检查。`IMPLEMENT_REQUEST` 的投递成功不表示可以越过待批准 Decision。

## 投递与重试

`send` 返回 `{ message_id, delivered: true }`，只代表接收回调完成，不是 Review APPROVE 或 Human Approval。

- 同一 Session 内，完全相同的消息 ID / idempotency key 和内容共享一次投递，包括并发调用。
- 对已有 ID / key 使用不同内容，返回 `IDEMPOTENCY_CONFLICT`。本参考版本要求重试保留整个 Envelope，包括 timestamp 和 message_id。
- 未认证、跨 task / repository、越权、Schema 不合法或没有路由时，不调用接收者。
- 接收者抛错时记录 `DELIVERY_UNCERTAIN`。因为副作用可能已发生，相同消息的重试返回相同错误，不重复投递。宿主须先核实结果，再决定是否产生新请求。

主要错误码：`UNAUTHENTICATED`、`INVALID_SCHEMA`、`AUTHORITY_BOUNDARY_EXCEEDED`、`SESSION_SCOPE_EXCEEDED`、`ROUTE_UNAVAILABLE`、`IDEMPOTENCY_CONFLICT`、`DELIVERY_UNCERTAIN`。

## 生命周期与持久化

Bridge 不持有业务状态机、实现器循环或审批按钮；路由回调由宿主安装。会话 grants、去重和审计在当前实例内有效。进程退出后不能依赖旧 Bridge 提供重复请求保护。

远程服务集成还需宿主身份认证、会话撤销、资源限额和持久化交付记录。这些是尚未接入的 Transport 能力，不更改 Human 的最终权威或 Decision Boundary。
