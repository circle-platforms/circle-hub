"""Unauthenticated configured-listener MCP probe; no gateway imports or credentials."""
from __future__ import annotations

import http.client
import ipaddress
import json
import math
from pathlib import Path
import re
import socket
import ssl
import time


class ProbeConfigError(ValueError):
    pass


def _listen(config_path):
    values, section, seen = {}, None, False
    for raw in Path(config_path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if line.startswith('['):
            section = line
            if section == '[listen]':
                if seen:
                    raise ProbeConfigError()
                seen = True
            continue
        if section != '[listen]':
            continue
        key = re.match(r'^(host|port|tls_cert|tls_key)\s*=', line)
        if not key:
            continue
        name = key[1]
        if name in values:
            raise ProbeConfigError()
        if name == 'port':
            match = re.fullmatch(r'port\s*=\s*([0-9]+)\s*(?:#.*)?', line)
            if not match:
                raise ProbeConfigError()
            values[name] = int(match[1])
        else:
            match = re.fullmatch(name + r'''\s*=\s*(["'])([^\\"'\r\n]*)\1\s*(?:#.*)?''', line)
            if not match:
                raise ProbeConfigError()
            values[name] = match[2]
    if not isinstance(values.get('host'), str) or not isinstance(values.get('port'), int) or not 1 <= values['port'] <= 65535:
        raise ProbeConfigError()
    if bool(values.get('tls_cert')) != bool(values.get('tls_key')):
        raise ProbeConfigError()
    host = values['host']
    if host == 'localhost':
        host = '127.0.0.1'
    elif host == '0.0.0.0':
        host = '127.0.0.1'
    elif host == '::':
        host = '::1'
    else:
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            raise ProbeConfigError()
        host = str(address)
    return host, values['port'], bool(values.get('tls_cert'))


def _result(outcome, ok=False):
    return {'status': 'ok' if ok else 'error', 'outcome': outcome}


def probe(config_path, timeout):
    """Send exactly one unauthenticated POST ping; return only status/outcome."""
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        return _result('invalid_timeout')
    try:
        host, port, tls = _listen(config_path)
    except (OSError, UnicodeError, ValueError, TypeError):
        return _result('listen_config_unavailable')
    deadline = time.monotonic() + timeout
    payload = json.dumps({'jsonrpc': '2.0', 'id': 'value-pick-probe', 'method': 'ping', 'params': {}}).encode('ascii')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return _result('timeout')
    connection = None
    try:
        if tls:
            # Configured-listener liveness only. Do not load CA/client/private-key files;
            # certificate identity and authenticated tools are separate ops checks.
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            connection = http.client.HTTPSConnection(host, port, timeout=remaining, context=context)
        else:
            connection = http.client.HTTPConnection(host, port, timeout=remaining)
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json', 'Connection': 'close'}
        connection.request('POST', '/mcp', body=payload, headers=headers)
        response = connection.getresponse()
        status = response.status
        if status in (401, 403):
            return _result('authentication_required', True)
        if 300 <= status < 400:
            return _result('redirect_refused')
        if status >= 500:
            return _result('http_server_error')
        if status == 404:
            return _result('mcp_endpoint_missing')
        if status not in (200, 400):
            return _result('unexpected_http_response')
        if response.getheader('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            return _result('mcp_response_unconfirmed')
        chunks, length = [], 0
        while True:
            if time.monotonic() >= deadline:
                return _result('timeout')
            part = response.read1(min(4096, 65537 - length))
            if not part:
                break
            chunks.append(part)
            length += len(part)
            if length > 65536:
                return _result('mcp_response_unconfirmed')
        value = json.loads(b''.join(chunks).decode('utf-8'))
        if not isinstance(value, dict) or value.get('jsonrpc') != '2.0' or value.get('id') != 'value-pick-probe':
            return _result('mcp_response_unconfirmed')
        error = value.get('error')
        rpc_error = isinstance(error, dict) and type(error.get('code')) is int and isinstance(error.get('message'), str)
        if (status == 200 and 'result' in value and 'error' not in value) or (rpc_error and 'result' not in value):
            return _result('mcp_response_received', True)
        return _result('mcp_response_unconfirmed')
    except (socket.timeout, TimeoutError):
        return _result('timeout')
    except (OSError, http.client.HTTPException, UnicodeError, ValueError):
        return _result('connection_or_response_failed')
    finally:
        if connection is not None:
            connection.close()
