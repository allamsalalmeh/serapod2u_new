/** Read-only staging audit; run from app with node --env-file=.env.local scripts/sa-finalization-v2-audit.mjs. No mutation RPCs. */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
async function rows(table,select='*') {
 const out=[]
 for(let offset=0;;offset+=1000){const r=await db.from(table).select(select).order('id').range(offset,offset+999);if(r.error)throw new Error(`${table}: ${r.error.code}`);out.push(...r.data);if(r.data.length<1000)return out}
}
const [permissions,policies,assignments,memberships,users,modes,readiness,settings,overview,root]=await Promise.all([
 rows('sa_permissions'),rows('sa_business_roles','*,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))'),
 rows('sa_role_assignments','*,scopes:sa_assignment_scopes(scope:sa_scope_definitions(scope_type,scope_value,status))'),rows('sa_organization_memberships'),rows('users','id,is_active'),
 db.from('sa_migration_modes').select('permission_key,mode'),db.from('sa_enforcement_readiness').select('permission_key,route_wiring,database_backstop,notes'),
 db.from('sa_settings').select('setting_key,setting_value').in('setting_key',['emergency_access.enabled','emergency_access.mfa_step_up_available']),db.rpc('sa_legacy_compat_overview'),
 db.from('sa_root_access_grants').select('user_id,status,effective_until').eq('status','active')])
for(const r of [modes,readiness,settings,overview,root])if(r.error)throw new Error(r.error.code)
const now=Date.now(), active=r=>r?.status==='active'&&(!r.effective_from||Date.parse(r.effective_from)<=now)&&(!r.effective_until||Date.parse(r.effective_until)>now)
const byRole=new Map(policies.map(r=>[r.id,r])), byMember=new Map(memberships.map(r=>[r.id,r]))
const activeUsers=new Set(users.filter(r=>r.is_active===true).map(r=>r.id)), roots=new Set(root.data.filter(active).map(r=>r.user_id))
const live=assignments.filter(a=>active(a)&&active(byMember.get(a.membership_id))&&byRole.get(a.role_id)?.status==='active'&&activeUsers.has(a.user_id))
const keys=p=>p.permissions.map(r=>r.permission?.permission_key).filter(Boolean), scopes=a=>a.scopes.map(r=>r.scope).filter(s=>s?.status==='active')
const covers=(r,l)=>scopes(l).length>0&&scopes(l).every(s=>scopes(r).some(x=>x.scope_type===s.scope_type&&x.scope_value===s.scope_value))
const alias=id=>'user-'+createHash('sha256').update(id).digest('hex').slice(0,10)
const gates=readFileSync('src/lib/security-access/route-coverage.ts','utf8'), matrix=[]
for(const policy of policies.filter(r=>r.source==='legacy').sort((a,b)=>a.role_key.localeCompare(b.role_key)))for(const key of keys(policy).sort()){
 const p=permissions.find(p=>p.permission_key===key),holders=live.filter(a=>a.role_id===policy.id),relying=[],assigned=new Set(),system=new Set()
 for(const h of holders){const replacements=live.filter(a=>a.user_id===h.user_id&&a.membership_id===h.membership_id&&byRole.get(a.role_id)?.source!=='legacy'&&keys(byRole.get(a.role_id)).includes(key)&&covers(a,h))
 for(const r of replacements)(['automatic','derived','backfill','hr','lifecycle'].includes(r.source)?system:assigned).add(byRole.get(r.role_id).role_key)
 if(!replacements.length&&!roots.has(h.user_id))relying.push({user:alias(h.user_id),organization:byMember.get(h.membership_id).organization_id})}
 matrix.push({legacyPolicy:policy.role_key,status:policy.status,permission:key,module:p?.module,operation:p?.action,catalogue:Boolean(p),backendGate:gates.includes(`"${key}"`)||gates.includes(`'${key}'`),databaseGate:['rpc_guard','rls_gate','transition_guard','decision_backstop','governance_function','read_only'].includes(readiness.data.find(r=>r.permission_key===key)?.database_backstop),databaseBackstop:readiness.data.find(r=>r.permission_key===key)?.database_backstop,sensitive:p?.audit_sensitivity!=='ordinary',currentHolderCount:new Set(holders.map(a=>a.user_id)).size,currentScopes:holders.flatMap(h=>scopes(h).map(scope=>({user:alias(h.user_id),organization:byMember.get(h.membership_id).organization_id,type:scope.scope_type,value:scope.scope_value}))),assignedCoverage:[...assigned],systemCoverage:[...system],relying,candidates:policies.filter(p=>p.source!=='legacy'&&p.status==='active'&&keys(p).includes(key)).sort((a,b)=>keys(a).length-keys(b).length).map(p=>p.role_key),approval:'Explicit per-target organization, scope, extra privileges and SoD review'})
}
const drift=await db.rpc('sa_standard_policy_drift');if(drift.error)throw new Error(drift.error.code)
const summary={standardPolicyDrift:drift.data,capturedAt:new Date().toISOString(),permissionCount:permissions.length,policyCount:policies.length,modes:modes.data.reduce((a,r)=>(a[r.mode]=(a[r.mode]||0)+1,a),{}),emergency:settings.data,legacy:overview.data,conservativeLegacyOnlyPairs:matrix.reduce((n,r)=>n+r.relying.length,0),legacyOnlyUsers:new Set(matrix.flatMap(r=>r.relying.map(p=>p.user))).size,paymentPolicies:policies.filter(p=>['customer-growth-full-access','ecommerce-payment-gateway-administrator'].includes(p.role_key)).map(p=>({key:p.role_key,permissions:keys(p)})),securityFullAccess:policies.filter(p=>p.role_key==='security-access-full-access').map(p=>({key:p.role_key,permissions:keys(p)})),caveat:'Conservative exact scope comparison. Hierarchy/delegation, per-resource restrictions and SoD require owner review. User aliases omit identities; protected preview resolves actual users. Catalogue matches are not approved replacements.'}
mkdirSync('../docs/security/sa-finalization-v2',{recursive:true})
writeFileSync('../docs/security/sa-finalization-v2/read-only-audit.json',JSON.stringify({summary,matrix},null,2)+'\n')
const esc=v=>String(v??'').replaceAll('|','\\|').replaceAll('\n',' ')
const lines=['# Legacy permission coverage matrix','',`Snapshot ${summary.capturedAt}: ${permissions.length} permissions; ${policies.length} policies. No database changes.`,'',summary.caveat,'','Coverage uses active, in-window same-membership grants with exact scope containment. API/DB gates are registration metadata, not a new runtime RLS test. Organization IDs and pseudonymous relying users appear in the JSON companion. All candidates require business approval.','','| Legacy policy | Permission | Module / operation | Catalogue | API / DB gate | Sensitive | Holders | Scope types | Legacy-only pairs | Assigned coverage | System coverage | Replacement candidates |','|---|---|---|---|---|---|---|---|---|---|---|---|']
for(const r of matrix)lines.push('| '+[r.legacyPolicy,r.permission,`${r.module} / ${r.operation}`,r.catalogue,`${r.backendGate} / ${r.databaseGate}`,r.sensitive,r.currentHolderCount,[...new Set(r.currentScopes.map(s=>s.type))].join(', '),r.relying.length,r.assignedCoverage.join(', '),r.systemCoverage.join(', '),r.candidates.join(', ')].map(esc).join(' | ')+' |')
writeFileSync('../docs/security/sa-finalization-v2/LEGACY_COVERAGE.md',lines.join('\n')+'\n')
console.log(JSON.stringify(summary,null,2))
