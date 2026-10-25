// Deployment-shape fixtures; all remote words and fields are synthetic.
export function definition(endpoint: string) {
  return {
    schema: 'executor@1', environment:'test', enabled: true, target: 'synthetic-bed', manifest_sha256: 'a'.repeat(64), endpoint, ca: '',
    actor: { header: 'X-Circle-Hub-Actor', pattern: '^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$', max_length: 128 },
    precheck_context: { build: 'synthetic-build' },
    resources: ['synthetic/device/a', 'synthetic/device/b'], max_run_ms: 9000, max_bytes: 1048576,
    poll_ms: 20, submit_timeout_ms: 300000,
    payload_argument: '/blob',
    allowed_tools: ['open_slot', 'touch_slot', 'close_slot', 'inspect_slot', 'send_blob', 'inspect_blob', 'read_blob'],
    calls: {
      acquire: { tool: 'open_slot', arguments: { actor: { $value: 'job' } } },
      heartbeat: { tool: 'touch_slot', arguments: { ticket: { $value: 'lease_id' }, token: { $value: 'lease_token' } } },
      release: { tool: 'close_slot', arguments: { ticket: { $value: 'lease_id' }, token: { $value: 'lease_token' } } },
      precheck: { tool: 'inspect_slot', arguments: {} },
      submit: { tool: 'send_blob', arguments: { request: { $value: 'request_id' }, dispatch_sequence: { $value: 'dispatch_sequence' }, sequence_scope: { $value: 'sequence_scope' }, blob: { $value: 'payload_base64' }, digest: { $value: 'sha256' }, ids: { $value: 'items' }, ticket: { $value: 'lease_id' } } },
      status: { tool: 'inspect_blob', arguments: { key: { $value: 'remote_id' } } },
      result: { tool: 'read_blob', arguments: { key: { $value: 'remote_id' } } },
    },
    lease: { id: '/ticket', token: '/token', ttl_ms: '/ttl', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' } },
    receipt: { request_id: '/request', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' }, id: '/key', sha256: '/digest', items: '/ids' },
    status: { pointer: '/state', exit_code: '/exit', map: { queued: { effect_outcome: 'issued' }, working: { effect_outcome: 'issued' }, ended: { action_result: 'completed', effect_outcome: 'effective' }, vanished: { effect_outcome: 'unknown' } } },
    result: { id: '/key', sha256: '/digest', submitted_at: '/submitted', items: '/rows', item_id: '/id', item_outcome: '/outcome', map: { good: 'pass', bad: 'fail' }, complete: '/complete' },
    conditions: [{ pointer: '/build', equals: { $value: 'build' } }, { pointer: '/seats', at_least: 2 }, { pointer: '/reachable', equals: true }],
    proof: { package: 'synthetic-workflow', manifest_sha256: '/bed/manifest_sha256', requirement: 'workbook_verified', warrant_id: 'synthetic.verify@1', slot: 'synthetic-artifact', plan_run: '/plan_run', sha256: '/sha256', items: '/autoids', target: '/bed/id', build: '/build', generator: '/generator' },
  };
}
