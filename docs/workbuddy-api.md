# WorkBuddy API 契约

编排器通过 HTTP 调用 WorkBuddy，要求它执行 `build` 或 `respond_to_reviews` 两类任务。

## 配置

- repo variable：`WORKBUDDY_API_URL`（例如 `https://workbuddy.example.com/api`）
- repo secret：`WORKBUDDY_API_TOKEN`（Bearer token）

## 端点

`POST {WORKBUDDY_API_URL}/dispatch`

## 请求头

```text
Authorization: Bearer $WORKBUDDY_API_TOKEN
Content-Type: application/json
```

## 请求体

```json
{
  "kind": "build",
  "repo": "owner/repo",
  "task": "仅 build 时：任务描述",
  "pr_number": "仅 respond_to_reviews 时：PR 编号"
}
```

- `kind = "build"`：WorkBuddy 按 `task` 写代码，完成测试后开 PR，并按 `WORKBUDDY.md` 打标签。
- `kind = "respond_to_reviews"`：WorkBuddy 读取该 PR 上的新评审意见，逐条回应（同意修复 / 反对举证 / 延期说明），修复后 push。

## 响应

- `200/202`：`{ "accepted": true, "id": "..." }`
- `4xx/5xx`：视为失败，GitHub Actions 会报错。

## 如果 WorkBuddy API 不是这个形状

只需改 `.github/workflows/workbuddy-dispatch.yml` 中 `curl` 一步的 URL、headers 和 payload，保持 `kind` 的语义不变即可。契约本身不要求 WorkBuddy 的底层实现。
