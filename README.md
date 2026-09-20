# 林权融资占用监测

面向集体林权改革与林下产业协作场景的林权融资占用服务：登记经营权证与地块范围、
维护估值版本、管理金融机构授信额度冻结、分期提款、提前偿还、部分地块释放与整笔
解除，并实时给出可用余量。所有状态由仅追加事件日志确定性折叠而来，最终余额、
冲突响应与监管审计均可重算、可验篡改。

## 运行与测试

```bash
npm test     # 单元 + HTTP 集成测试（13 个用例）
npm start    # 启动服务，默认端口 3000，事件文件位于 ./data/events
```

- `PORT`：HTTP 端口（默认 3000）
- `EVENT_STORE_DIR`：仅追加事件文件目录（默认 `./data/events`）

## 身份

联调环境由网关注入请求头（生产应替换为 mTLS/签名验签主体）：

- `x-actor-role: regulator`：金融监管协作人员，可登记权证/估值、查看全部数据、执行审计；
- `x-actor-role: institution` + `x-actor-id: <机构编号>`：金融机构，只能操作、
  查看本机构授信；他机构占用只显示 `heldBy: "other_institution"` 占位，不暴露授信编号。

## API 一览

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/certificates` | 监管 | 登记权证与地块范围 |
| POST | `/v1/certificates/:id/valuations` | 监管 | 追加估值版本（可更正/下调，永不覆盖） |
| GET | `/v1/certificates` | 双方 | 列出可见权证与实时余量 |
| GET | `/v1/certificates/:id` | 双方 | 权证详情（机构视图经权限裁剪） |
| GET | `/v1/credits/:id` | 双方 | 授信详情（仅限本机构或监管） |
| POST | `/v1/credits/freeze` | 机构 | 冻结授信额度并附着地块（并发安全） |
| POST | `/v1/credits/:id/drawdowns` | 机构 | 分期提款 |
| POST | `/v1/credits/:id/repayments` | 机构 | （提前）偿还 |
| POST | `/v1/credits/:id/releases` | 机构 | 按 FIFO 顺序部分释放地块 |
| POST | `/v1/credits/:id/revocation` | 机构 | 请求解除：立即进入“撤销中”，阻断新提款 |
| POST | `/v1/credits/:id/revocation/confirm` | 机构 | 余额为零后确认解除，归还全部地块 |
| GET | `/v1/audit` | 监管 | 重放事件、校验哈希链、输出可重算报告 |
| GET | `/health` | 匿名 | 健康检查 |

写操作均可携带 `idempotencyKey`：机构回执乱序或重投时返回首次处理结果，
不产生重复占用。冲突响应携带结构化 `details`（冲突地块、占用机构、当前余量等）。

## 核心规则

- **可融资上限** = 当前估值版本 × 抵质押率（0.7，按地块折算）。
- **可用余量** = min(授信冻结额度, 附着地块当前可融资上限) − 已提款余额；
  估值下调即时收缩余量，覆盖不足时标记 `coverageBreached` 并阻断新提款。
- **冻结互斥**：同一地块同一时刻只能附着一笔授信；并发冻结由乐观锁 + 重放裁定，
  恰有一家成功。
- **释放次序**：地块必须按附着先后（FIFO，先附着先释放）释放；仍有未偿余额时
  不能释放全部地块。
- **撤销次序**：`撤销请求（阻断新提款）→ 余额清零 → 确认解除`，次序由事件日志位置固定。
- **审计可重算**：事件携带 `prevHash/hash` 前向哈希链，监管可脱离服务只读事件文件
  重新折叠并验篡改。

## 架构

```
src/domain/
  clock.mjs      单调混合时钟（时间+序号），确定事件全序
  events.mjs     事件结构、规范化哈希
  store.mjs      仅追加存储（文件实现 / 内存实现），expectedVersion 乐观锁
  projection.mjs 事件折叠 -> 当前状态与余量视图
  service.mjs    命令校验、幂等、并发重试、权限、审计
src/server.mjs   HTTP 路由与身份头
```

落盘的只有不可变事件；没有独立的可变数据库表，重启即重放。
