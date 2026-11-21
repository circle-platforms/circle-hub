"""Assemble a private runner without changing the shared framework files."""

from __future__ import annotations

import copy
import functools
import hashlib
import importlib.util
import inspect
import json
import re
import sys
import time
import types
from pathlib import Path

from table_cell import CELL_EFFECT, CELL_VALUE_POLICY, PARAMETER_ROLES, PARAMETER_TYPES, CellSelectionError, checked_value_policy, table_cell

COMPONENT_ROOT = Path(__file__).resolve().parent
COMPONENT_FILES = ('entry.py', 'cell_runtime.py', 'cell_gateway.py',
                   'table_cell.py', 'test_xlsx.py')
SOURCE_PREFIX = 'cell-runtime/'
CELL_METHOD_SOURCE = SOURCE_PREFIX + 'cell_runtime.py'
VERSION = '1.3.0'
HUB_FIELDS = ('types', 'roles', 'effects', 'promotions', 'cleanup', 'destructive',
              'exec_failure_markers', 'refused_access')
RUNTIME_FIELDS = ('block_model', 'checkpoint_two_argument')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def contract_digest(document):
    return hashlib.sha256(canonical({
        key: value for key, value in document.items()
        if key != 'contract_sha256'
    })).hexdigest()


# A rule has two identities. Its whole digest (contract_sha256) says which bytes run: it takes in the digest of every source
# file, so one changed byte in any of them makes it another rule. A workbook does not depend on those bytes; it depends on what
# the rule declares: the objects, their methods and signatures, the actions and what the runtime can do. interface_form is the
# rule without the members that only say which bytes: its own digest, the digests of the sources, the runner's file and digest,
# the certification and snapshot records, the line a declaration stands on, and which receipts stand behind a certified
# status. Only those named members are left out, so a member this form does not know counts. Its digest is the identity a
# workbook carries and the private entry pins; the whole digest stays what the start of a run checks against the files. A
# repair that changes how a method works and nothing it declares therefore leaves compiled workbooks valid. The Hub's package
# computes the same form (packs/workflow/case-compile/functions/runtime-contract.ts interfaceForm).
INTERFACE_OMITTED = ('contract_sha256', 'source_hashes', 'certification', 'atlas_snapshot')
INTERFACE_RUNTIME_OMITTED = ('runner_source', 'runner_sha256')
INTERFACE_SOURCE_IN = ('objects', 'entries', 'execute_actions')
INTERFACE_SOURCE_OMITTED = ('line',)
RECEIPT_AUTHORITY = 'device_receipt_set:'


def declared(item):
    if not isinstance(item, dict):
        return item
    result = dict(item)
    if isinstance(result.get('source'), dict):
        result['source'] = {name: value for name, value in result['source'].items()
                            if name not in INTERFACE_SOURCE_OMITTED}
    authority = result.get('status_authority')
    if isinstance(authority, str) and authority.startswith(RECEIPT_AUTHORITY):
        result['status_authority'] = RECEIPT_AUTHORITY
    return result


def interface_form(document):
    result = {}
    for key, member in document.items():
        if key in INTERFACE_OMITTED:
            continue
        if key == 'runtime' and isinstance(member, dict):
            member = {name: value for name, value in member.items()
                      if name not in INTERFACE_RUNTIME_OMITTED}
        elif key in INTERFACE_SOURCE_IN and isinstance(member, list):
            member = [declared(item) for item in member]
        result[key] = member
    return result


def interface_digest(document):
    return hashlib.sha256(canonical(interface_form(document))).hexdigest()


def workbook_rule(contract):
    """The rule as the framework's runner holds it against a workbook: the identity it reads is the interface identity."""
    view = dict(contract)
    view['contract_sha256'] = interface_digest(contract)
    return view


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def copy_function(function, namespace):
    result = types.FunctionType(function.__code__, namespace, function.__name__,
                                function.__defaults__, function.__closure__)
    result.__kwdefaults__ = function.__kwdefaults__
    result.__annotations__ = function.__annotations__
    result.__dict__.update(function.__dict__)
    return result


def runner_namespace(module, contract):
    namespace = dict(vars(module))
    for name, value in vars(module).items():
        if inspect.isfunction(value) and value.__module__ == module.__name__:
            namespace[name] = copy_function(value, namespace)
    namespace['_load_excel_contract'] = lambda: contract
    return namespace


def export_contract(framework_root, base_contract, objects):
    root = Path(framework_root).resolve()
    # Export reads declared source bytes; framework and fixture imports may open device sessions.
    verified_base = json.loads((root / 'lib/excel_contract.json').read_text(encoding='utf-8'))
    supplied_base = json.loads(Path(base_contract).read_text(encoding='utf-8'))
    if (canonical(verified_base) != canonical(supplied_base)
            or verified_base.get('schema') != 'ist.excel.function-contract'
            or verified_base.get('complete') is not True
            or contract_digest(verified_base) != verified_base.get('contract_sha256')):
        raise ValueError('指定原规则与原入口实际加载的规则不同')
    sources = dict(verified_base['source_hashes'])
    for relative, expected in sources.items():
        path = (root / relative).resolve()
        if root not in path.parents or file_digest(path) != expected:
            raise ValueError('原规则声明的来源文件与实际内容不同')
    for relative in ('lib/test_xlsx.py', 'smoke_test/conftest.py'):
        if relative not in sources:
            raise ValueError('原规则缺少入口或设备工厂的来源声明')
    for entry in verified_base['entries']:
        if entry.get('source', {}).get('path') not in sources:
            raise ValueError('原规则的方法来源未登记文件摘要')
    if (verified_base['runtime']['runner_source'] != 'lib/test_xlsx.py'
            or verified_base['runtime']['runner_sha256'] != sources['lib/test_xlsx.py']):
        raise ValueError('原规则的入口身份与来源声明不同')
    document = copy.deepcopy(verified_base)
    available = {item.get('e', item.get('name')) for item in document['objects']
                 if item['status'] == 'enabled'}
    if not objects or any(name not in available for name in objects):
        raise ValueError('取格对象须来自原规则已声明且启用的对象')
    for name in COMPONENT_FILES:
        sources[SOURCE_PREFIX + name] = file_digest(COMPONENT_ROOT / name)
    public_method = CellDevice(None, None).table_cell
    signature = inspect.signature(public_method)
    parameters = []
    for parameter in signature.parameters.values():
        variadic = parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD)
        parameters.append({
            'name': parameter.name,
            'kind': parameter.kind.name.lower(),
            'required': parameter.default is parameter.empty and not variadic,
            'default': None if parameter.default is parameter.empty else repr(parameter.default),
        })
    source_line = inspect.getsourcelines(public_method)[1]
    for name in objects:
        document['entries'].append({
            'e': name, 'f': 'table_cell',
            'python_symbol': 'cell_runtime.CellDevice.table_cell',
            'signature': {
                'parameters': parameters,
                'required': [item['name'] for item in parameters if item['required']],
                'optional': [item['name'] for item in parameters if not item['required']],
                'text': str(signature),
            },
            'g_syntax': 'Readable table shape and exact column equality arguments',
            'h_semantics': 'Stores the selected cell text unchanged',
            'i_semantics': 'Uses a saved device output as the first positional argument',
            'dispatch': 'direct_method_call', 'status': 'enabled', 'reason': '',
            'status_authority': 'project_policy:excel-authoring-v1',
            'source': {'path': CELL_METHOD_SOURCE, 'line': source_line},
            'minimum_runtime': document['runtime']['minimum_version'],
            'parameter_roles': PARAMETER_ROLES,
            'parameter_types': PARAMETER_TYPES,
            'cell_effect': CELL_EFFECT,
        })
    document['source_hashes'] = sources
    document['runtime']['runner_source'] = SOURCE_PREFIX + 'test_xlsx.py'
    document['runtime']['runner_sha256'] = sources[SOURCE_PREFIX + 'test_xlsx.py']
    document['atlas_snapshot']['cell_runtime'] = {
        'version': VERSION, 'base_contract_sha256': verified_base['contract_sha256'],
    }
    document['contract_sha256'] = contract_digest(document)
    return document


def original_of(document):
    result = {key: copy.deepcopy(value) for key, value in document.items()
              if key not in HUB_FIELDS + ('schema', 'contract_sha256', 'original')}
    for entry in result['entries']:
        entry.pop('typed_authority', None)
    for key in RUNTIME_FIELDS:
        result['runtime'].pop(key, None)
    result['schema'] = 'ist.excel.function-contract'
    result['contract_sha256'] = document['original']['contract_sha256']
    return result


def export_hub_contract(original_path, base_hub_path):
    raw = Path(original_path).read_bytes()
    original = json.loads(raw)
    base = json.loads(Path(base_hub_path).read_text(encoding='utf-8'))
    restored = original_of(base)
    base_identity = original['atlas_snapshot']['cell_runtime']['base_contract_sha256']
    if (base['schema'] != 'runtime-contract@2'
            or contract_digest(original) != original['contract_sha256']
            or contract_digest(base) != base['contract_sha256']
            or contract_digest(restored) != base_identity
            or base['original']['contract_sha256'] != base_identity):
        raise ValueError('新原件与旧Hub规则的原始来源不对应')
    document = copy.deepcopy(original)
    document['schema'] = 'runtime-contract@2'
    document['original'] = {
        'contract_sha256': original['contract_sha256'],
        'interface_sha256': interface_digest(original),
        'sha256': hashlib.sha256(raw).hexdigest(),
    }
    for field in HUB_FIELDS:
        if field in base:
            document[field] = copy.deepcopy(base[field])
    for field in RUNTIME_FIELDS:
        if field in base['runtime']:
            document['runtime'][field] = copy.deepcopy(base['runtime'][field])
    prior = {(entry['e'], entry['f']): entry for entry in base['entries']}
    same = set()
    for entry in document['entries']:
        old = prior.get((entry['e'], entry['f']))
        if old is None:
            continue
        source = entry.get('source', {}).get('path')
        if (source and entry.get('source') == old.get('source')
                and entry['signature'] == old['signature']
                and entry.get('python_symbol') == old.get('python_symbol')
                and original['source_hashes'].get(source) == base['source_hashes'].get(source)
                and source in original['source_hashes']):
            same.add((entry['e'], entry['f']))
            if 'typed_authority' in old:
                entry['typed_authority'] = copy.deepcopy(old['typed_authority'])
    if 'promotions' in document:
        document['promotions'] = [item for item in document['promotions']
                                  if (item['object'], item['method']) in same]
    for field in ('cleanup', 'destructive', 'exec_failure_markers', 'refused_access'):
        value = document.get(field)
        if (value and value.get('source') in original['source_hashes']
                and original['source_hashes'][value['source']] != value.get('sha256')):
            document.pop(field)

    cells = [(index, entry) for index, entry in enumerate(document['entries'])
             if entry['f'] == 'table_cell'
             and entry.get('source', {}).get('path') == CELL_METHOD_SOURCE]
    if not cells:
        raise ValueError('新原件没有取格方法的明确源声明')
    reference = 'src:' + document['original']['sha256'] + '/json@1/p/entries/' + str(cells[0][0])
    document.setdefault('types', {})
    for kind, parameter in (('string', 'output'), ('int', 'columns')):
        name = 'cell_' + kind
        document['types'][name] = {'declaration': {
            'name': name, 'declaration': reference + '/parameter_types/' + parameter,
            'grammar': 'runtime-contract@2', 'catalog_type': kind,
        }}
    document.setdefault('roles', {})
    for role, parameter in (('cell_source', 'output'), ('cell_selection', 'conditions')):
        document['roles'][role] = {'source': reference + '/parameter_roles/' + parameter}
    effect = cells[0][1]['cell_effect']
    document.setdefault('effects', {})['cell_selection'] = {
        'source': reference + '/cell_effect', 'roles': effect['roles'],
        'budget': effect['budget'], 'allowed_literals': [], 'command_roles': [],
    }
    for index, entry in cells:
        source = 'src:' + document['original']['sha256'] + '/json@1/p/entries/' + str(index)
        entry['typed_authority'] = {
            'source': source + '/cell_effect',
            'parameters': {
                name: {'type': 'cell_' + kind, 'role': entry['parameter_roles'][name]}
                for name, kind in entry['parameter_types'].items()
            },
            'effects': ['cell_selection'],
        }
    block = document['runtime']['block_model']
    block['cell_methods'] = [{'object': entry['e'], 'method': entry['f']} for _, entry in cells]
    block['cell_inputs'] = True
    block['output_methods'] = block.get('output_methods', []) + [
        {'object': entry['e'], 'method': entry['f'], 'output': 'cell_text'}
        for _, entry in cells
    ]
    document['contract_sha256'] = contract_digest(document)
    return document


def read_contract(path, framework_root, entry_path=None):
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    if document['schema'] != 'ist.excel.function-contract' or document['complete'] is not True:
        raise ValueError('独立入口需要完整的原格式执行器规则')
    if contract_digest(document) != document['contract_sha256']:
        raise ValueError('独立执行器规则的内容与身份不同')
    runner = SOURCE_PREFIX + 'test_xlsx.py'
    if (document['runtime']['runner_source'] != runner
            or document['runtime']['runner_sha256'] != document['source_hashes'].get(runner)):
        raise ValueError('独立入口的源文件身份不一致')
    for name in COMPONENT_FILES:
        if SOURCE_PREFIX + name not in document['source_hashes']:
            raise ValueError('取格规则缺少本组件的完整来源摘要')
    framework = Path(framework_root).resolve()
    for source, expected in document['source_hashes'].items():
        own = source.startswith(SOURCE_PREFIX)
        root = COMPONENT_ROOT if own else framework
        relative = source[len(SOURCE_PREFIX):] if own else source
        location = root / relative
        if location.is_symlink() or root not in location.resolve().parents:
            raise ValueError('规则源码不在声明范围内')
        if own and relative == 'test_xlsx.py' and entry_path is not None:
            location = Path(entry_path)
        if file_digest(location) != expected:
            raise ValueError('独立入口实际加载文件与执行器规则不一致：' + source)
    for entry in document['entries']:
        if entry['f'] == 'table_cell' and entry['status'] == 'enabled':
            policy = checked_value_policy(entry.get('cell_effect', {}).get('value_policy'))
            if entry.get('source', {}).get('path') != CELL_METHOD_SOURCE or policy != CELL_VALUE_POLICY:
                raise ValueError('取格值策略与完整性已核的组件来源声明不一致')
    return document


# A device can take a session out of configuration mode by itself: while a peer writes its configuration to it, it prints a
# notice and shows the enable prompt. The framework keeps its own note of the mode (device.shell) and does not read that. Its
# next enable-mode command then begins with "exit", which at the enable prompt ends the session: the rest of the case reads
# nothing and the cleanup of that device raises, so a workbook's later cases get no run. Its next configuration command is
# typed at the enable prompt, refused there, and repeated after "config ter force" only when its whole read window has passed.
# Both happened to one case in real runs (2026-11-20). session_guard looks, before either sender runs, at what the device has
# already sent: the text goes to the session's log like every other read, and when it ends at the enable prompt while the note
# says configuration mode, an enable-mode command is sent where the session stands and a configuration command after the
# framework's own "config ter force". With nothing waiting, nothing is read and nothing changes. The senders are replaced on the
# device itself, so the framework's cleanup and close, which call them from inside, are covered as well.
SESSION_QUIET_SECONDS = 0.2
SESSION_READ_SECONDS = 2.0
ENTER_CONFIGURATION = 'config ter force'
CONFIGURATION_PROMPT = r'\(config\)#'


def waiting_output(device):
    channel = getattr(device, '_channel', None)
    ready = getattr(channel, 'recv_ready', None)
    if not callable(ready) or not ready():
        return ''
    text, quiet, deadline = '', None, time.monotonic() + SESSION_READ_SECONDS
    while time.monotonic() < deadline:
        if ready():
            chunk = channel.recv(4096)
            if not chunk:
                break
            text, quiet = text + chunk.decode('utf-8', errors='ignore'), None
            continue
        quiet = time.monotonic() if quiet is None else quiet
        if time.monotonic() - quiet >= SESSION_QUIET_SECONDS:
            break
        time.sleep(0.02)
    if text:
        device.f.write(text)
        device.f.flush()
    return text


def session_guard(device):
    config, enable = getattr(device, 'cmd_config', None), getattr(device, 'cmd_enable', None)
    hostname = getattr(device, 'hostname', None)
    if (getattr(device, '_circle_session_guard', False) or not callable(config) or not callable(enable)
            or not callable(getattr(device, 'read_until', None)) or not isinstance(hostname, str) or not hostname):
        return device

    def left_configuration():
        return (getattr(device, 'shell', None) == 'config'
                and waiting_output(device).rstrip().endswith(hostname + '#'))

    def enter(command, seconds):
        device.my_cmd = command
        device._channel.send(command + '\n')
        return device.read_until(CONFIGURATION_PROMPT + '|' + re.escape(hostname) + '#', seconds)

    @functools.wraps(config)
    def cmd_config(cmd, *args, **kwargs):
        if getattr(device, 'shell', None) == 'enable':
            # The framework sends "conf ter" here and takes configuration mode for entered. While another session holds it
            # the device refuses and stays at the enable prompt, where the command would be typed and refused. The entry is
            # made here instead, its answer is read, and a refusal is followed by the framework's own "config ter force".
            waiting_output(device)
            if enter('conf ter', 5).rstrip().endswith(hostname + '#'):
                enter(ENTER_CONFIGURATION, 10)
            device.shell = 'config'
        elif left_configuration():
            enter(ENTER_CONFIGURATION, 10)
        return config(cmd, *args, **kwargs)

    @functools.wraps(enable)
    def cmd_enable(cmd, *args, **kwargs):
        if left_configuration():
            device.shell = 'enable'
        # The framework's timeout line names device.my_cmd, which only its configuration sender sets.
        device.my_cmd = cmd
        return enable(cmd, *args, **kwargs)

    device.cmd_config, device.cmd_enable, device._circle_session_guard = cmd_config, cmd_enable, True
    return device


# A cell that cannot be picked fails its own case and nothing else. The framework runs every case of a workbook in one function
# and catches nothing, so an exception from one step ended the whole workbook: twice in real runs one case's selection of two rows
# left the other sixteen cases without a run or a verdict. The failure is therefore recorded through the framework's own
# checkpoint (the case is judged failed, the log carries the position and the device's words), the register gets a fixed name
# that is no value of any device, and a command of this device that would carry that name is not sent. Every other step of the
# case, its cleanup, and the other cases go on as written. Without a checkpoint to record on, the exception is raised as before.
CELL_NOT_SELECTED = 'cell-not-selected'
CELL_PICKED = '取格：恰好取到一格'


class CellDevice:
    def __init__(self, device, value_policy, check_point=None):
        self._device = device
        self._value_policy = value_policy
        self._check_point = check_point

    def __getattr__(self, name):
        value = getattr(self._device, name)
        if name.startswith('_') or not callable(value):
            return value

        @functools.wraps(value)
        def call(*args, **kwargs):
            if any(isinstance(item, str) and CELL_NOT_SELECTED in item for item in list(args) + list(kwargs.values())):
                return ''
            return value(*args, **kwargs)
        return call

    def table_cell(self, output, *conditions, separator, columns, column,
                   format='delimited', header=0, row=0) -> str:
        try:
            return table_cell(output, *conditions, separator=separator, columns=columns,
                              column=column, format=format, header=header, row=row,
                              value_policy=self._value_policy)
        except CellSelectionError as error:
            record = getattr(self._check_point, 'abs_found', None)
            if not callable(record):
                raise
            record(CELL_PICKED, str(error))
            return CELL_NOT_SELECTED


class Runtime:
    def __init__(self, framework_root, contract_path, entry_path=None):
        self.framework_root = Path(framework_root).resolve()
        self.contract_path = Path(contract_path).resolve()
        self.contract = read_contract(self.contract_path, self.framework_root, entry_path)
        self.value_policies = {}
        for item in self.contract['entries']:
            if item['f'] != 'table_cell' or item['status'] != 'enabled':
                continue
            if item['e'] in self.value_policies or item.get('source', {}).get('path') != CELL_METHOD_SOURCE:
                raise ValueError('取格方法身份重复或不是当前组件的明确来源')
            self.value_policies[item['e']] = checked_value_policy(item.get('cell_effect', {}).get('value_policy'))
        self.objects = set(self.value_policies)
        sys.path.insert(0, str(self.framework_root))
        base = load_module('_circle_cell_runner', self.framework_root / 'lib/test_xlsx.py')
        if (self.contract['runtime']['minimum_version'] != base.EXCEL_FUNCTION_CONTRACT_VERSION
                or not base._contract_shape_valid(self.contract)):
            raise ValueError('独立执行器规则的版本或形状不符合原执行协议')
        self.namespace = runner_namespace(base, workbook_rule(self.contract))

    def invoke(self, request, factory, logger, configer, check_point, db, workbook):
        runtime = self

        class Request:
            def __getattr__(self, name):
                return getattr(request, name)

            def getfixturevalue(self, name):
                value = request.getfixturevalue(name)
                return CellDevice(session_guard(value), runtime.value_policies[name], check_point) if name in runtime.objects else value

        def wrapped_factory(*args, **kwargs):
            policies = list(runtime.value_policies.values())
            if not policies or any(value != policies[0] for value in policies[1:]):
                raise ValueError('设备工厂的对象尚未明确，不能在不同取格值策略之间猜选')
            return CellDevice(session_guard(factory(*args, **kwargs)), policies[0], check_point)

        return self.namespace['test_xlsx'](
            Request(), wrapped_factory, logger, configer, check_point, db, str(workbook))


ACTIVE = None


def active(entry_path):
    if ACTIVE is not None:
        return ACTIVE
    settings = json.loads(Path(entry_path).with_name('cell-runtime.json').read_text(encoding='utf-8'))
    return Runtime(settings['framework_root'], Path(entry_path).with_name('excel_contract.json'), entry_path)


def run(framework_root, contract_path, workbook, pytest_args):
    global ACTIVE
    ACTIVE = Runtime(framework_root, contract_path, COMPONENT_ROOT / 'test_xlsx.py')
    fixtures = load_module('_circle_cell_fixtures',
                           Path(framework_root) / 'smoke_test/conftest.py')

    class Workbook:
        def pytest_generate_tests(self, metafunc):
            if 'xlsx_file' in metafunc.fixturenames:
                metafunc.parametrize('xlsx_file', [str(Path(workbook).resolve())],
                                     ids=[Path(workbook).name])

    import os
    import pytest
    os.chdir(framework_root)
    return pytest.main([str(COMPONENT_ROOT / 'test_xlsx.py'), '-s'] + pytest_args,
                       plugins=[fixtures, Workbook()])
