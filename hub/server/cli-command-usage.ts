import { DEFAULT_ADMIN_NAME } from '../records/api.ts';
import { NAMED_SECRET_USAGE } from './variables.ts';

export const SECRET_USAGE = NAMED_SECRET_USAGE;
export const ORIGINAL_USAGE = 'original list [--external <外部标识的前缀>] [--suffix <外部标识的后缀>] [--limit <条数>] | export <sha256> --out <文件>';
export const LEASE_USAGE = 'lease list [--prefix <键前缀>] | release <键> --reason <理由> | register <前缀> --owner <用户> --reason <理由> | unregister <前缀> --reason <理由>';
export const SHARE_USAGE = 'share run <运行> (--users <用户,…> | --pack-users) [--reason <理由>] | production <工作流> [--reason <理由>] | list [--object <对象>]';
export const UNSHARE_USAGE = 'unshare run <运行> (--user <用户> | --pack-users) | production <工作流>';
export const DOC_USAGE = 'doc put <名字> <文件> | list | show <名字>';
export const INIT_ADMIN_USAGE = `init-admin [<用户名>] [--password-stdin]   建第一位管理员（省略用户名时为 ${DEFAULT_ADMIN_NAME}），密码从标准输入读取或随机生成；操作令牌存进私有密钥文件，不显示`;
export const OPERATOR_TOKEN_USAGE =
  'operator-token set   从标准输入读一个启用中的管理员的令牌，存进私有密钥文件（账户 operator-token）；令牌文件丢失时用，已有的不覆盖 | reissue [--as <管理员>]   手里没有管理员令牌时：给一位启用中的管理员签发新令牌，直接存进私有密钥文件，不显示；已有的不覆盖 | remove --confirm-only-operator-token   仅删除本地操作令牌文件，不改主密钥、不撤销数据库令牌';


export const SERVE_USAGE = 'serve [--migrate-only] [--migrate]   启动 Hub（默认只监听本机；配置了内置 HTTPS 时另开 HTTPS）；--migrate-only 以拥有表的角色应用迁移后退出；--migrate 用连接角色先迁移（单角色的开发环境）';
