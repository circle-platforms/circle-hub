"""Export or run the isolated cell executor, or serve its MCP submission route."""

import argparse
import json
from pathlib import Path



def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export-contract')
    export.add_argument('--framework-root', required=True)
    export.add_argument('--base-contract', required=True)
    export.add_argument('--object', action='append', dest='objects', required=True)
    export.add_argument('--out', required=True)
    hub = commands.add_parser('export-hub-contract')
    hub.add_argument('--original', required=True)
    hub.add_argument('--base-hub-contract', required=True)
    hub.add_argument('--out', required=True)
    execute = commands.add_parser('run')
    execute.add_argument('--framework-root', required=True)
    execute.add_argument('--contract', required=True)
    execute.add_argument('--xlsx', required=True)
    execute.add_argument('pytest_args', nargs=argparse.REMAINDER)
    service = commands.add_parser('serve')
    service.add_argument('--gateway-root', required=True)
    service.add_argument('--config', required=True)
    service.add_argument('--contract', required=True)
    args = parser.parse_args()
    if args.command != 'serve':
        from cell_runtime import contract_digest, export_contract, export_hub_contract, run
    if args.command in ('export-contract', 'export-hub-contract'):
        document = (export_contract(args.framework_root, args.base_contract, args.objects)
                    if args.command == 'export-contract'
                    else export_hub_contract(args.original, args.base_hub_contract))
        target = Path(args.out)
        with target.open('x', encoding='utf-8') as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        target.chmod(0o600)
        print(json.dumps({'entries': len(document['entries']),
                          'sources': len(document['source_hashes']),
                          'contract_sha256': contract_digest(document)}))
        return 0
    if args.command == 'run':
        arguments = args.pytest_args[1:] if args.pytest_args[:1] == ['--'] else args.pytest_args
        return run(args.framework_root, args.contract, args.xlsx, arguments)
    from cell_gateway import serve
    return serve(args.gateway_root, args.config, args.contract)


if __name__ == '__main__':
    raise SystemExit(main())
