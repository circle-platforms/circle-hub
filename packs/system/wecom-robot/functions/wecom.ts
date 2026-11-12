// Read functions of the WeCom robot system pack (pure, run in the Hub sandbox). The service answers HTTP 200 with an
// envelope {errcode, errmsg} and errcode 0 carries the record. The member read backs the external-identity mapping a
// B07 answer needs (userid -> named Hub account, checked against the stored original); the chat read names a group's
// owner and members, which is what a delivery audience is checked against. Sending is not here: an outbound message is
// an executor@1 write declaration made at deployment, never a route of this profile, so the transport refuses it.

type Response = { ok?: boolean; json?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MEMBER_KEY = /^[A-Za-z0-9_@.-]{1,64}$/;
const CHAT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Is this a well-formed WeCom userid? The shape only; whether the tenant knows it is what the read answers. */
export function isMemberKey(key: string): boolean {
  return typeof key === 'string' && MEMBER_KEY.test(key);
}

/** Is this a well-formed appchat id? */
export function isChatKey(key: string): boolean {
  return typeof key === 'string' && CHAT_KEY.test(key);
}

function partsOf(input: unknown): { type: string; key: string; responses: Record<string, Response>; original: string } {
  const record = isRecord(input) ? input : {};
  const external = isRecord(record.external) ? record.external : {};
  return {
    type: typeof external.type === 'string' ? external.type : '',
    key: typeof external.key === 'string' ? external.key : '',
    responses: (isRecord(record.responses) ? record.responses : {}) as Record<string, Response>,
    original: typeof record.original === 'string' ? record.original : '',
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const nums = (value: unknown): number[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'number') : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/** Projection of wecom:user:<userid>: the member as the answer gives it; absent fields stay null, never guessed. */
export function memberProject(input: unknown): unknown {
  const { type, key, responses, original } = partsOf(input);
  if (type !== 'user') return { error: { code: 'wecom.invalid_type', message: '类型不是 user' } };
  if (!isMemberKey(key)) return { error: { code: 'wecom.invalid_key', message: '成员标识无效（1 到 64 位字母、数字、_ @ . -）' } };
  const answer = responses[original]?.json;
  if (!isRecord(answer)) return { error: { code: 'wecom.no_record', message: '成员应答不是对象' } };
  const userid = text(answer.userid);
  if (userid === null || userid !== key) return { error: { code: 'wecom.absent', message: `企业微信不认识成员 ${key}` } };
  const name = text(answer.name);
  const department = nums(answer.department);
  const status = typeof answer.status === 'number' ? answer.status : null;
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { userid, name, department, status, mobile: text(answer.mobile), email: text(answer.email) } },
      { name: 'meta', media_type: 'application/json', json: { userid, name } },
    ],
  };
}

/** Projection of wecom:chat:<chatid>: the chat_info the service answers under the envelope. */
export function chatProject(input: unknown): unknown {
  const { type, key, responses, original } = partsOf(input);
  if (type !== 'chat') return { error: { code: 'wecom.invalid_type', message: '类型不是 chat' } };
  if (!isChatKey(key)) return { error: { code: 'wecom.invalid_key', message: '群标识无效（1 到 64 位字母、数字、_ -）' } };
  const answer = responses[original]?.json;
  if (!isRecord(answer)) return { error: { code: 'wecom.no_record', message: '群应答不是对象' } };
  const info = isRecord(answer.chat_info) ? answer.chat_info : null;
  const chatid = info === null ? null : text(info.chatid);
  if (info === null || chatid === null || chatid !== key) return { error: { code: 'wecom.absent', message: `企业微信不认识群 ${key}` } };
  const userList = isRecord(info.user_list) ? info.user_list : {};
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { chatid, name: text(info.name), owner: text(info.owner), users: strings(userList.user), department: nums(userList.department) } },
      { name: 'meta', media_type: 'application/json', json: { chatid, name: text(info.name), owner: text(info.owner) } },
    ],
  };
}
