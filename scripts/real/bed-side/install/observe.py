#!/usr/bin/env python3
"""Read-only installation facts; no gateway/framework imports or network calls."""
from __future__ import annotations

import ast
from datetime import datetime, timedelta
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import sqlite3
import stat
import subprocess
import sys
import time
from contextlib import closing


class Unknown(Exception):
    pass


class MissingAlive(Unknown):
    pass


def read_component_state(component):
    file = Path(component) / 'runtime/status.json'
    if file.is_symlink() or not file.is_file():
        raise Unknown('state_missing_or_not_regular')
    state = json.loads(file.read_text(encoding='utf8'))
    if not isinstance(state, dict) or set(state) != {'schema', 'mode', 'reason', 'recorded_at', 'pid'} or state['schema'] != 'value-pick-state@1' or state['mode'] not in ('cell', 'original') or not (state['reason'] is None or isinstance(state['reason'], str)):
        raise Unknown('state_shape_invalid')
    if type(state['pid']) is not int or state['pid'] <= 0:
        raise Unknown('state_pid_invalid')
    raw = state['recorded_at']
    if not isinstance(raw, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)', raw):
        raise Unknown('state_time_not_utc')
    when = datetime.fromisoformat(raw[:-1] + '+00:00' if raw.endswith('Z') else raw)
    if when.utcoffset() != timedelta(0):
        raise Unknown('state_time_not_utc')
    return state


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise Unknown('not_regular')
    return info


def directory(path):
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise Unknown('not_directory')
    return path


def walk_error(error):
    raise error


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def source(path):
    regular(path)
    return ast.parse(path.read_text(encoding='utf-8'))


def assignment(tree, name):
    matches = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            matches.append(node.value)
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            matches.append(node.value)
    if len(matches) != 1:
        raise Unknown('static_declaration_unknown')
    return matches[0]


def static_declarations(root, phase, component):
    version = ast.literal_eval(assignment(source(root / 'gateway/service.py'), 'SERVER_INFO'))['version']
    specs = assignment(source(root / 'gateway/tools.py'), 'TOOL_SPECS')
    if not isinstance(version, str) or not isinstance(specs, ast.List):
        raise Unknown('static_declaration_unknown')
    tools = []
    for entry in specs.elts:
        if not isinstance(entry, ast.Dict):
            raise Unknown('static_tools_unknown')
        names = [v for k, v in zip(entry.keys, entry.values) if isinstance(k, ast.Constant) and k.value == 'name']
        if len(names) != 1:
            raise Unknown('static_tools_unknown')
        tools.append(ast.literal_eval(names[0]))
    if phase == 'wrapped':
        source(component / 'entry.py')
        tools.append(ast.literal_eval(assignment(source(component / 'cell_gateway.py'), 'SUBMIT_TOOL')))
    if not tools or any(not isinstance(n, str) or not re.fullmatch(r'[a-z_]+', n) for n in tools) or len(set(tools)) != len(tools):
        raise Unknown('static_tools_unknown')
    return version, sorted(tools)


def system_properties(unit):
    result = subprocess.run(['systemctl', 'show', unit, '--property=MainPID', '--property=ControlGroup', '--property=ExecStart', '--property=WorkingDirectory'],
                            capture_output=True, text=True, timeout=5, check=False)
    if result.returncode:
        raise Unknown('systemd_unavailable')
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def current_component(values, root, config):
    raw = values['ExecStart']
    match = re.fullmatch(r"\{ path=[^;]+ ; argv\[\]=(.*?) ; [^{}]*\}", raw.strip())
    if not match:
        raise Unknown('launch_unknown')
    argv = shlex.split(match[1])
    if len(argv) == 6 and argv[1:5] == ['-m', 'gateway.cexg', 'serve', '--config']:
        actual_root, actual_config, component = Path(values['WorkingDirectory']), Path(argv[5]), None
    elif len(argv) == 5 and argv[2:4] == ['serve', '--config'] and Path(argv[1]).name == 'cexg.py':
        actual_root, actual_config, component = Path(argv[1]).parent.parent, Path(argv[4]), None
    elif len(argv) == 9 and Path(argv[1]).name == 'entry.py' and argv[2:4] == ['serve', '--gateway-root'] and argv[5] == '--config' and argv[7] == '--contract':
        actual_root, actual_config, component = Path(argv[4]), Path(argv[6]), Path(argv[1]).parent
    else:
        raise Unknown('launch_unknown')
    if actual_root != root or actual_config != config or component is not None and not component.is_absolute():
        raise Unknown('launch_source_mismatch')
    return component


def cgroup_processes(unit, proc_root, cgroup_root, properties):
    values = properties(unit)
    main = int(values['MainPID'])
    group = values['ControlGroup']
    if main <= 0 or not group.startswith('/') or '..' in Path(group).parts or group == '/':
        raise Unknown('cgroup_unknown')
    memberships = (proc_root / str(main) / 'cgroup').read_text().splitlines()
    parsed = [line.split(':', 2) for line in memberships]
    if any(len(row) != 3 for row in parsed):
        raise Unknown('cgroup_unknown')
    if any(row == ['0', '', group] for row in parsed) and (cgroup_root / 'cgroup.controllers').is_file():
        root = cgroup_root / group.lstrip('/')
    elif any('name=systemd' in row[1].split(',') and row[2] == group for row in parsed):
        root = cgroup_root / 'systemd' / group.lstrip('/')
    else:
        raise Unknown('cgroup_layout_unknown')
    directory(root)
    pids = set()
    for current, dirs, _files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs:
            directory(Path(current) / name)
        for raw in (Path(current) / 'cgroup.procs').read_text().splitlines():
            pid = int(raw)
            if pid <= 0:
                raise Unknown('cgroup_unknown')
            pids.add(pid)
    if main not in pids:
        raise Unknown('cgroup_main_missing')
    return pids - {main}


def readonly_database(path):
    regular(path)
    # Never use immutable=1: it would omit committed WAL state. Refuse a WAL
    # lacking its already-existing SHM rather than allow SQLite to create it.
    wal = path.with_name(path.name + '-wal')
    if wal.exists():
        regular(wal)
        regular(path.with_name(path.name + '-shm'))
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        return conn
    except Exception:
        conn.close()
        raise


def lease_and_tasks(state, boot, monotonic):
    with closing(readonly_database(state / 'state.db')) as conn:
        rows = conn.execute('SELECT released,clock_epoch,monotonic_deadline FROM lease WHERE bed=?', ('bed',)).fetchall()
        task_ids = [row[0] for row in conn.execute('SELECT task_id FROM tasks ORDER BY task_id')]
    leased = False
    for released, epoch, deadline in rows:
        if type(released) is not int or released not in (0, 1):
            raise Unknown('lease_schema_unknown')
        if released or epoch != boot:
            continue
        if deadline is None:
            continue
        if not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
            raise Unknown('lease_deadline_unknown')
        leased |= deadline > monotonic
    if any(not isinstance(task, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', task) for task in task_ids):
        raise Unknown('task_identity_unknown')
    return leased, set(task_ids)


def held_lock(path):
    regular(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
    try:
        opened, current = os.fstat(fd), path.lstat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise Unknown('lock_identity_changed')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EACCES):
                return True
            raise
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def task_locks(root, task_ids):
    directory(root)
    ids = set(task_ids)
    suffixes = ('.status.json', '.runner.json', '.stage.json', '.started', '.alive', '.sh', '.log', '.xml')
    for item in root.iterdir():
        for suffix in suffixes:
            if item.name.endswith(suffix):
                ids.add(item.name[:-len(suffix)])
                break
    held = 0
    for task in sorted(ids):
        alive = root / (task + '.alive')
        try:
            alive.lstat()
        except FileNotFoundError:
            raise MissingAlive('task_alive_missing') from None
        held += held_lock(alive)
    return held


def inventory(root):
    directory(root)
    rows = []
    for current, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in sorted(dirs + files):
            item = Path(current) / name
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode):
                # Record the link itself; stage_case intentionally links shared files.
                rows.append([item.relative_to(root).as_posix(), 'symlink', info.st_mode & 0o777,
                             hashlib.sha256(os.fsencode(os.readlink(item))).hexdigest(),
                             info.st_mtime_ns, info.st_ctime_ns])
                if name in dirs:
                    dirs.remove(name)
                continue
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise Unknown('inventory_entry_unknown')
            checksum = None
            if stat.S_ISREG(info.st_mode) and (item.suffix in ('.py', '.sh', '.log', '.xml', '.xlsx', '.alive', '.started') or item.name.endswith(('.status.json', '.runner.json', '.stage.json')) or item.name in ('excel_contract.json', 'cell-runtime.json')):
                h = hashlib.sha256()
                fd = os.open(item, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                with os.fdopen(fd, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if before.st_ino != info.st_ino or before.st_dev != info.st_dev:
                        raise Unknown('inventory_changed_during_read')
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        h.update(chunk)
                    after = os.fstat(stream.fileno())
                if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
                    raise Unknown('inventory_changed_during_read')
                checksum = h.hexdigest()
            rows.append([item.relative_to(root).as_posix(), stat.S_IFMT(info.st_mode),
                         info.st_mode & 0o777, info.st_size if stat.S_ISREG(info.st_mode) else 0,
                         info.st_mtime_ns, info.st_ctime_ns, checksum])
    return sorted(rows)


def request_inventories(state):
    journal = state.with_name(state.name + '.request-journal') / 'requests.db'
    with closing(readonly_database(journal)) as conn:
        # Hash the complete durable request rows in memory; no values leave this process.
        # request_events is the flushable delivery queue, not persistent request identity.
        rows = {
            'requests_columns': [row[1] for row in conn.execute('PRAGMA table_info(requests)')],
            'requests': conn.execute('SELECT * FROM requests ORDER BY request_id').fetchall(),
            'request_meta': conn.execute('SELECT name,value FROM request_meta ORDER BY name').fetchall(),
            'request_tombstones': conn.execute('SELECT request_id,not_after FROM request_tombstones ORDER BY request_id').fetchall(),
        }
    # clock_floor is the exact mutable clock key written by ed89f6c StateStore._request_now.
    # Keep it in the full inventory; expose only a second hash from this SAME read transaction.
    clock = [row for row in rows['request_meta'] if row[0] == 'clock_floor']
    return digest(rows), digest(clock), bool(clock)


def request_inventory(state):
    return request_inventories(state)[0]


def config_paths(config):
    # Only these two simple quoted TOML strings are needed. Do not interpret
    # credentials, escapes, interpolation or alternate TOML forms.
    section, values, sections = None, {}, set()
    for raw in config.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if line.startswith('['):
            section = line
            if section in ('[state]', '[framework]'):
                if section in sections:
                    raise Unknown('config_section_duplicate')
                sections.add(section)
        wanted = 'dir' if section == '[state]' else 'staging_parent' if section == '[framework]' else None
        if wanted and re.match(r'^' + wanted + r'\s*=', line):
            match = re.fullmatch(wanted + r"\s*=\s*([\"'])([^\\\"'\r\n]+)\1\s*(?:#.*)?", line)
            if not match or section in values:
                raise Unknown('config_path_unsupported')
            values[section] = Path(match[2])
    if set(values) != {'[state]', '[framework]'}:
        raise Unknown('config_path_missing')
    return values['[state]'], values['[framework]']


def observe(request, *, proc_root=Path('/proc'), cgroup_root=Path('/sys/fs/cgroup'), properties=system_properties):
    facts = dict(schema='value-pick-observation@1', jobs=None, leased=None, bed_busy=None,
                 version=None, tools=None, component_state=None, diagnostics=[], task_inventory_sha256=None, request_records_sha256=None, request_clock_sha256=None, verified=False)
    required = {'operation', 'unit', 'phase', 'gateway_root', 'config_path'}
    if not isinstance(request, dict) or request.get('operation') != 'observe' or request.get('phase') not in ('original', 'wrapped', 'preflight', 'copy_version', 'export_original', 'export_typed', 'dropin', 'reload', 'restart', 'postcheck'):
        return facts
    if set(request) not in (required, required | {'component_root'}):
        return facts
    if not isinstance(request['unit'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', request['unit']):
        return facts
    try:
        root, config = Path(request['gateway_root']), Path(request['config_path'])
        regular(config)
        # Config paths only; never follow any credential-file field.
        state, staging = config_paths(config)
        if any(not p.is_absolute() for p in [root, config, state, staging]):
            return facts
        directory(state)
    except (OSError, ValueError, TypeError, KeyError, Unknown):
        return facts
    def attempt(fn, diagnostic=None):
        try:
            return fn()
        except MissingAlive:
            facts['diagnostics'].append('task_alive_missing')
            return None
        except (OSError, ValueError, TypeError, KeyError, SyntaxError, sqlite3.Error, Unknown, subprocess.SubprocessError):
            if diagnostic is not None:
                facts['diagnostics'].append(diagnostic)
            return None
    values = attempt(lambda: properties(request['unit']))
    def declarations_now():
        # ExecStart changes at daemon-reload, before the old process is restarted. Read the actual MainPID argv.
        main = int(values['MainPID'])
        if main <= 0:
            raise Unknown('main_process_unknown')
        command = proc_root / str(main) / 'cmdline'
        regular(command)
        argv = command.read_bytes().rstrip(b'\0').decode('utf-8').split('\0')
        if not argv or not argv[0]:
            raise Unknown('main_command_unknown')
        actual = dict(values)
        actual['ExecStart'] = '{ path=' + argv[0] + ' ; argv[]=' + shlex.join(argv) + ' ; ignore_errors=no ; }'
        component = current_component(actual, root, config)
        if 'component_root' in request and Path(request['component_root']) != component:
            raise Unknown('component_source_mismatch')
        if request['phase'] in ('wrapped', 'postcheck') and component is None:
            raise Unknown('phase_source_mismatch')
        state = read_component_state(component) if component is not None else None
        if state is not None and state['pid'] != main:
            raise Unknown('state_pid_stale')
        version, tools = static_declarations(root, 'wrapped' if state is not None and state['mode'] == 'cell' else 'original', component)
        return version, tools, state
    declarations = attempt(declarations_now) if values else None
    if declarations:
        facts['version'], facts['tools'], facts['component_state'] = declarations
    pids = attempt(lambda: cgroup_processes(request['unit'], proc_root, cgroup_root, lambda _unit: values))
    if pids:
        facts['diagnostics'].append('cgroup_extra_processes')
    boot = attempt(lambda: (proc_root / 'sys/kernel/random/boot_id').read_text().strip())
    lease = attempt(lambda: lease_and_tasks(state, boot, time.monotonic())) if boot else None
    if lease:
        facts['leased'] = lease[0]
    held = attempt(lambda: task_locks(state / 'tasks', lease[1]), 'task_locks_unknown') if lease else None
    if pids is not None and held is not None:
        # This is a conservative activity count; only zero asserts absence.
        facts['jobs'] = len(pids) + held
    facts['bed_busy'] = attempt(lambda: held_lock(state / 'bed.lock'))
    facts['task_inventory_sha256'] = attempt(lambda: digest([inventory(state / 'tasks'), inventory(staging)]))
    requests = attempt(lambda: request_inventories(state), 'request_inventory_unknown')
    if requests is not None:
        facts['request_records_sha256'], facts['request_clock_sha256'], clock_included = requests
        if clock_included:
            facts['diagnostics'].append('request_clock_included')
    facts['verified'] = all(facts[key] is not None for key in facts if key not in ('schema', 'verified', 'component_state', 'diagnostics'))
    return facts


def main():
    try:
        value = observe(json.load(sys.stdin))
    except Exception:
        value = dict(schema='value-pick-observation@1', jobs=None, leased=None, bed_busy=None,
                     version=None, tools=None, component_state=None, diagnostics=[], task_inventory_sha256=None, request_records_sha256=None, request_clock_sha256=None, verified=False)
    print(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False))


if __name__ == '__main__':
    main()
