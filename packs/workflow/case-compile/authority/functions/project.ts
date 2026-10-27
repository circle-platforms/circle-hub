import { productAuthority } from './recompose-authority.ts';
export default function (input: any) { const bound = productAuthority(input.inputs ?? [], input.context ?? {}); return { items: [], groups: [{ kind: 'recompose-product@1', ...bound }], warnings: [] }; }
