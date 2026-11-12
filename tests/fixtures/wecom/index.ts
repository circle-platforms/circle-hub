// Synthetic WeCom robot answers (the structure mirrors the real service; every value is invented, no hosts, no keys):
// HTTP 200 with the envelope {errcode, errmsg} and errcode 0 ok, member records keyed by userid, chat records keyed by
// chatid, and a SEND route under the same prefix that a read-only client must never reach. wecomReply answers one
// request; a test wires it into a loopback stub (hub/connectors/testing startStub).
// A member the tenant does not know answers errcode 0 without a userid here, so the projection can report the absence
// as a recorded fact; the real service answers a nonzero errcode for unknown ids, which is a check to settle when the
// routes are sampled for a deployment (see the pack README, Needs).

export const WRITE_PATH = '/cgi-bin/appchat/send/';
export const TOKEN_PATH = '/cgi-bin/gettoken';

export interface WeComRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  json?: unknown;
}

export interface WeComReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const MEMBERS: Record<string, Record<string, unknown>> = {
  syn_u_001: { errcode: 0, errmsg: 'ok', userid: 'syn_u_001', name: '合成-甲', department: [7], status: 1, mobile: '13800000000', email: 'syn001@example.invalid' },
  syn_u_002: { errcode: 0, errmsg: 'ok', userid: 'syn_u_002', name: '合成-乙', department: [7, 9], status: 1 },
};

export const CHATS: Record<string, Record<string, unknown>> = {
  syn_chat_001: {
    errcode: 0,
    errmsg: 'ok',
    chat_info: { chatid: 'syn_chat_001', name: '合成-评审群', owner: 'syn_u_001', user_list: { user: ['syn_u_001', 'syn_u_002'], department: [7] } },
  },
};

const json = (value: unknown): WeComReply => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

/** Answer one synthetic request by route; an unknown member or chat is an ok envelope without the record. */
export function wecomReply(request: WeComRequest): WeComReply {
  if (request.method === 'GET' && request.path === '/cgi-bin/user/get') {
    const userid = request.query?.userid ?? '';
    return json(MEMBERS[userid] ?? { errcode: 0, errmsg: 'ok' });
  }
  if (request.method === 'POST' && request.path === '/cgi-bin/appchat/get') {
    const body = request.json as { chatid?: unknown } | undefined;
    const chatid = typeof body?.chatid === 'string' ? body.chatid : '';
    return json(CHATS[chatid] ?? { errcode: 0, errmsg: 'ok' });
  }
  return json({ errcode: 40409, errmsg: 'route not on the read list' });
}
