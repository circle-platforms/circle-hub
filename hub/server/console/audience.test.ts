import type {User} from '../../records/api.ts';
import type {AudienceGrant} from './audience.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeAudience,directoryName} from './audience.ts';
const user=(id:string,role:User['role']='user',disabled=false)=>({id,name:id,role,disabled,created_at:'',updated_at:''});
test('audiences union inherited grants, exclude disabled accounts and hide foreign grant details',()=>{
 const input={owner:'a',viewer:'a',ownerName:'a',path:'/spec/auth',users:[user('a'),user('b'),user('c','admin'),user('d','admin',true)],grants:[{path:'/spec',audience:'member',member:'b'},{path:'/',audience:'administrators',member:null},{path:'/spec/auth',audience:'member',member:'c'}] as AudienceGrant[]};
 const own=describeAudience(input);assert.equal(own.text,'已分享给 1 名成员、全体管理员（当前 1 人）');assert.deepEqual(own.members,['b','c']);assert.deepEqual(own.inherited,['/spec','/']);
 assert.deepEqual(describeAudience({...input,viewer:'b'}),{text:'来自 a',inherited:[],members:[]});
 assert.equal(describeAudience({...input,grants:[]}).text,'仅自己可见');assert.equal(directoryName('/接口规范/认证'),'接口规范 › 认证');
});
test('the current administrator total includes an administrator owner without duplicating the owner in member details',()=>{
 const audience=describeAudience({owner:'a',viewer:'a',ownerName:'a',users:[user('a','admin'),user('b','admin')],grants:[{path:'/',audience:'administrators',member:null}]});
 assert.equal(audience.text,'已分享给全体管理员（当前 2 人）');assert.deepEqual(audience.members,['b']);
});
