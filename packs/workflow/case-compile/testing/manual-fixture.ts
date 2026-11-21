// A synthetic manual for the quotation checks: one chapter whose entries stand next to each other the way the entries of a real manual do
// (a parameter row, the sentence of the command, the sentence of the next command, an introduction and a flag line), a second chapter that
// repeats one sentence inside a longer entry, and the references the Hub writes for them. The words are made up; only the shape is real: a
// chapter name with a space (written %20 in a reference), full-width brackets that stay raw, and a sentence that is one entry's whole text.
import {pathOf} from '../../../../hub/refs/api.ts';
import {manualEntryDigest,type ManualNode} from './locked-tree.ts';

export const CHAPTER=['cli-widget','演示服务（DEMO）','Widget Signing'];
export const APPENDIX=['cli-widget','演示服务（DEMO）','Widget Appendix'];
export const HOST_ROW='| host_name | 该参数指定一个已存在的演示域名。 |';
export const SIGN='该命令用于对指定演示域名的资源记录执行合成签名。执行后，设备将使用密钥为每一条资源记录生成对应的签名记录。';
export const PUBLISH='该命令用于将签名密钥发布到设备的指定演示域名根区。';
export const FLAGS_INTRO='密钥信息中的“status_flags”项的参数含义如下：';
export const HOST_SIGNED='HOST_SIGNED：表示该域名的资源已存在签名记录。';
/** A sentence that two entries hold: the chapter's own and the appendix's, which repeats it inside a longer entry. */
export const ECHOED='设备在执行前会先回显命令。';
export const REPEATED=`附录重复：${ECHOED}（同上）`;
export const MANUAL:ManualNode[]=[
 {words:CHAPTER,entries:[{statement:HOST_ROW},{statement:SIGN},{statement:PUBLISH},{statement:FLAGS_INTRO},{statement:HOST_SIGNED},{statement:ECHOED}]},
 {words:APPENDIX,entries:[{statement:REPEATED}]},
];
/** The reference of the entry with `statement` at the chapter `words`, as the Hub writes it for the tree of `root`. */
export const manualReference=(root:string,words:readonly string[],statement:string):string=>`tree:${root}${pathOf(['manual',...words])}@${manualEntryDigest(words,statement)}`;
