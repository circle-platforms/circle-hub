# Lumen API 2.1.0 接口参考

合成的接口说明。引用一个接口时写 `<方法> <路径> <参数取值...>`，参数按下表的顺序。

## GET /v1/pools

列出池，按名称排序。

| name | type | optional | minimum | maximum | minLength | maxLength | values |
| --- | --- | --- | --- | --- | --- | --- | --- |
| limit | int | true | 1 | 100 | | | |

## POST /v1/pools

创建一个池。

| name | type | optional | minimum | maximum | minLength | maxLength | values |
| --- | --- | --- | --- | --- | --- | --- | --- |
| name | string | false | | | 1 | 32 | |
| mode | enum | true | | | | | ["rr","lc","hash"] |

## DELETE /v1/pools/{id}

删除一个池；池里还有成员时返回 409。

| name | type | optional | minimum | maximum | minLength | maxLength | values |
| --- | --- | --- | --- | --- | --- | --- | --- |
| force | enum | true | | | | | ["true","false"] |

## GET /v1/health

返回服务状态，没有参数。

## 附录：错误码

409 表示冲突。
