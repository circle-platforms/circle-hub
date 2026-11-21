import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const COMPONENT = dirname(fileURLToPath(import.meta.url));
const env = { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' };

// A device's command line with its two modes, and a device object that sends through it the way the framework's does: it keeps
// its own note of the mode, leaves configuration mode with "exit" before an enable-mode command, and after a configuration
// command that came back at the enable prompt sends "config ter force" and the command again. Read windows are not waited for:
// a read that does not end at the expected prompt is recorded with the window it would have waited. While another session holds
// configuration mode the line refuses "conf ter" and stays at the enable prompt. Synthetic names only.
const MODEL = `import io, inspect, json, re, sys
sys.path.insert(0, sys.argv[1])
import cell_runtime

class Line:
    def __init__(self, host):
        self.host, self.mode, self.out, self.ended, self.sent, self.held = host, 'config', '', False, [], False
    def prompt(self):
        return self.host + ('(config)#' if self.mode == 'config' else '#')
    def leave_configuration(self):
        self.mode = 'enable'
        self.out += '\\n*** synthetic notice: no longer in configuration mode ***\\n\\n' + self.prompt()
    def recv_ready(self):
        return bool(self.out)
    def recv(self, size):
        data, self.out = self.out[:size], self.out[size:]
        return data.encode()
    def send(self, text):
        line = text.rstrip('\\n')
        self.sent.append([self.mode, line])
        if self.ended:
            return
        if line == 'exit' and self.mode == 'enable':
            self.ended = True
        elif line == 'exit':
            self.mode = 'enable'
            self.out += line + '\\n' + self.prompt()
        elif line == 'conf ter' and self.held:
            self.out += line + '\\nAnother session holds configuration mode.\\nFailed to execute the command\\n\\n' + self.prompt()
        elif line in ('conf ter', 'config ter force'):
            self.mode = 'config'
            self.out += line + '\\n' + self.prompt()
        elif self.mode == 'enable' and not line.startswith('show '):
            self.out += line + '\\n' + line + ' \\n^\\n\\n' + self.prompt()
        else:
            self.out += line + '\\nreply to ' + line + '\\n' + self.prompt()

class Device:
    def __init__(self, host='DUT'):
        self._channel, self.f, self.hostname, self.shell, self.my_cmd, self.windows = Line(host), io.StringIO(), host, 'config', '', []
    def read_until(self, expected, timeout=5):
        output = ''
        while self._channel.recv_ready():
            output += self._channel.recv(1024).decode()
        self.f.write(output)
        if not [m for m in re.finditer(expected, output) if not output[m.end():].strip()]:
            self.windows.append([self.my_cmd, timeout])
        return output
    def cmd_enable(self, cmd, prompt=None, timeout=10):
        if self.shell == 'config':
            self._channel.send('exit\\n')
            self.read_until('#')
            self.shell = 'enable'
        self._channel.send(cmd + '\\n')
        return self.read_until(prompt or '#', timeout)
    def cmd_config(self, cmd, prompt=None, timeout=10):
        prompt = prompt or r'\\(config\\)#'
        if self.shell == 'enable':
            self._channel.send('conf ter\\n')
            self.read_until(r'\\(config\\)#')
            self.shell = 'config'
        self.f.write(self._channel.recv(65536).decode())
        self._channel.send(cmd + '\\n')
        self.my_cmd = cmd
        output = self.read_until(prompt, timeout)
        if re.search(self.hostname + '#', output):
            self._channel.send('config ter force\\n')
            self.read_until(r'\\(config\\)#', 10)
            self._channel.send(cmd + '\\n')
            output = self.read_until(prompt, timeout)
        return output
    def clear(self):
        return self.cmd_config('clear synthetic all', timeout=60)

def run(p):
    device = Device()
    if p.get('guard'):
        assert cell_runtime.session_guard(device) is device
        assert cell_runtime.session_guard(device) is device
    device.cmd_config('synthetic object one')
    if p.get('start') == 'enable':
        device.cmd_enable('show synthetic first')
    device._channel.held = bool(p.get('held'))
    before = len(device._channel.sent)
    if p.get('leaves'):
        device._channel.leave_configuration()
    output = device.clear() if p['next'] == 'clear' else getattr(device, p['next'])(p['command'])
    return {'sent': device._channel.sent[before:], 'ended': device._channel.ended, 'output': output, 'shell': device.shell,
            'windows': device.windows, 'log': device.f.getvalue(),
            'signatures': [str(inspect.signature(device.cmd_config)), str(inspect.signature(device.cmd_enable))]}

print(json.dumps(run(json.load(sys.stdin))))
`;

interface Outcome { sent: [string, string][]; ended: boolean; output: string; shell: string; windows: [string, number][]; log: string; signatures: string[] }
function run(scenario: Record<string, unknown>): Outcome {
  const result = spawnSync('python3', ['-c', MODEL, COMPONENT], { input: JSON.stringify(scenario), encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout) as Outcome;
}

test('replay: after the device left configuration mode, the framework\'s enable-mode command ends the session with its "exit"', () => {
  const outcome = run({ leaves: true, next: 'cmd_enable', command: 'show synthetic list' });
  assert.deepEqual(outcome.sent, [['enable', 'exit'], ['enable', 'show synthetic list']]);
  assert.equal(outcome.ended, true);
  assert.doesNotMatch(outcome.output, /reply to/);
  // The line that reports the missed window names the configuration command sent before, not the command that was waiting.
  assert.deepEqual(outcome.windows, [['synthetic object one', 10]]);
});

test('with the guard the enable-mode command is sent where the session stands and its reply is read', () => {
  const outcome = run({ guard: true, leaves: true, next: 'cmd_enable', command: 'show synthetic list' });
  assert.deepEqual(outcome.sent, [['enable', 'show synthetic list']]);
  assert.equal(outcome.ended, false);
  assert.match(outcome.output, /reply to show synthetic list\nDUT#$/);
  assert.equal(outcome.shell, 'enable');
  assert.deepEqual(outcome.windows, []);
  assert.match(outcome.log, /synthetic notice: no longer in configuration mode/);
});

test('replay: after the device left configuration mode, a configuration command is typed at the enable prompt and waits out its window', () => {
  const outcome = run({ leaves: true, next: 'clear' });
  assert.deepEqual(outcome.sent, [['enable', 'clear synthetic all'], ['enable', 'config ter force'], ['config', 'clear synthetic all']]);
  assert.deepEqual(outcome.windows, [['clear synthetic all', 60]]);
  assert.match(outcome.log, /DUT#clear synthetic all\nclear synthetic all \n\^/);
});

test('with the guard the configuration command, sent from inside the device\'s own cleanup too, follows "config ter force" and is not refused', () => {
  const outcome = run({ guard: true, leaves: true, next: 'clear' });
  assert.deepEqual(outcome.sent, [['enable', 'config ter force'], ['config', 'clear synthetic all']]);
  assert.deepEqual(outcome.windows, []);
  assert.doesNotMatch(outcome.log, /\^/);
  assert.match(outcome.output, /reply to clear synthetic all\nDUT\(config\)#$/);
  assert.equal(outcome.shell, 'config');
});

test('with nothing waiting the guard sends what the framework sends, and both senders keep their parameters', () => {
  for (const scenario of [{ next: 'cmd_enable', command: 'show synthetic list' }, { next: 'cmd_config', command: 'synthetic object two' }, { next: 'clear' }, { start: 'enable', next: 'cmd_config', command: 'synthetic object two' }, { start: 'enable', next: 'cmd_enable', command: 'show synthetic list' }]) {
    const plain = run(scenario), guarded = run({ ...scenario, guard: true });
    assert.deepEqual(guarded.sent, plain.sent);
    assert.equal(guarded.output, plain.output);
    assert.equal(guarded.log, plain.log);
    assert.deepEqual(guarded.signatures, plain.signatures);
    assert.deepEqual(guarded.signatures, ['(cmd, prompt=None, timeout=10)', '(cmd, prompt=None, timeout=10)']);
  }
});

test('a missed window of an enable-mode command is reported under that command, and objects without the two senders are left as they are', () => {
  const silent = `import io, json, sys
sys.path.insert(0, sys.argv[1])
import cell_runtime
class Quiet:
    def recv_ready(self): return False
    def send(self, text): pass
class Device:
    def __init__(self):
        self._channel, self.f, self.hostname, self.shell, self.my_cmd, self.windows = Quiet(), io.StringIO(), 'DUT', 'enable', 'synthetic object one', []
    def read_until(self, expected, timeout=5):
        self.windows.append([self.my_cmd, timeout]); return ''
    def cmd_enable(self, cmd, prompt=None, timeout=10):
        self._channel.send(cmd); return self.read_until('#', timeout)
    def cmd_config(self, cmd, prompt=None, timeout=10):
        return ''
device = cell_runtime.session_guard(Device())
device.cmd_enable('show synthetic list')
class Other:
    def start(self): return 'started'
other = Other()
print(json.dumps({'windows': device.windows, 'other': cell_runtime.session_guard(other) is other and vars(other) == {}}))
`;
  const result = spawnSync('python3', ['-c', silent, COMPONENT], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout), { windows: [['show synthetic list', 10]], other: true });
});

// Round 51: a plan sent a configuration command to the peer while the other device was still writing its configuration to it.
// The framework's "conf ter" was refused ("someone else is in config mode"), the framework took configuration mode for entered,
// typed the command at the enable prompt, and the case's returns recorded a syntax refusal of a command that was right.
test('replay: while another session holds configuration mode the framework\'s entry is refused and its command is typed at the enable prompt', () => {
  const outcome = run({ start: 'enable', held: true, next: 'cmd_config', command: 'synthetic object two' });
  assert.deepEqual(outcome.sent, [['enable', 'conf ter'], ['enable', 'synthetic object two'], ['enable', 'config ter force'], ['config', 'synthetic object two']]);
  assert.match(outcome.log, /DUT#synthetic object two\nsynthetic object two \n\^/);
  assert.equal(outcome.windows.length, 2, 'the entry and the refused command each waited out a window');
});

test('with the guard a refused entry is read, followed by "config ter force", and the command is sent once, in configuration mode', () => {
  const outcome = run({ guard: true, start: 'enable', held: true, next: 'cmd_config', command: 'synthetic object two' });
  assert.deepEqual(outcome.sent, [['enable', 'conf ter'], ['enable', 'config ter force'], ['config', 'synthetic object two']]);
  assert.doesNotMatch(outcome.log, /\^/);
  assert.match(outcome.log, /conf ter\nAnother session holds configuration mode\.\nFailed to execute the command\n\nDUT#config ter force\nDUT\(config\)#/, 'the device\'s refusal of the entry stays in the session\'s log');
  assert.deepEqual(outcome.windows, []);
  assert.match(outcome.output, /reply to synthetic object two\nDUT\(config\)#$/);
  assert.equal(outcome.shell, 'config');
});
