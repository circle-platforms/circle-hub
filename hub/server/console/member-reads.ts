// Batch only the identities already authorized by the caller's member projection.
import type {Principals,Authorizations} from '../../records/api.ts';
export async function tokensForMembers(principals:Pick<Principals,'tokens'|'tokensMany'>,ids:readonly string[]){
 return principals.tokensMany?principals.tokensMany(ids):new Map(await Promise.all(ids.map(async id=>[id,await principals.tokens(id)] as const)));
}
export async function assignmentsForMembers(authorizations:Pick<Authorizations,'packsFor'|'packsForMany'>,ids:readonly string[]){
 return authorizations.packsForMany?authorizations.packsForMany(ids):new Map(await Promise.all(ids.map(async id=>[id,await authorizations.packsFor(id)] as const)));
}
