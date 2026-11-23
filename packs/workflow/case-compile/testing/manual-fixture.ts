import {pathOf} from '../../../../hub/refs/api.ts';
import {manualEntryDigest,type ManualNode} from './locked-tree.ts';

export const CHAPTER=['cli-widget','演示服务（DEMO）','Widget Signing'];
export const APPENDIX=['cli-widget','演示服务（DEMO）','Widget Appendix'];
export const HOST_ROW='| host_name | 该参数指定一个已存在的演示域名。 |';
export const SIGN='该命令用于对指定演示域名的资源记录执行合成签名。执行后，设备将使用密钥为每一条资源记录生成对应的签名记录。';
export const PUBLISH='该命令用于将签名密钥发布到设备的指定演示域名根区。';
export const FLAGS_INTRO='密钥信息中的“status_flags”项的参数含义如下：';
export const HOST_SIGNED='HOST_SIGNED：表示该域名的资源已存在签名记录。';
export const ECHOED='设备在执行前会先回显命令。';
export const REPEATED=`附录重复：${ECHOED}（同上）`;
export const MANUAL:ManualNode[]=[
 {words:CHAPTER,entries:[{statement:HOST_ROW},{statement:SIGN},{statement:PUBLISH},{statement:FLAGS_INTRO},{statement:HOST_SIGNED},{statement:ECHOED}]},
 {words:APPENDIX,entries:[{statement:REPEATED}]},
];
export const manualReference=(root:string,words:readonly string[],statement:string):string=>`tree:${root}${pathOf(['manual',...words])}@${manualEntryDigest(words,statement)}`;
