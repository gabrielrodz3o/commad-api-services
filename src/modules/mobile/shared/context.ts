import type { FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { query } from '../../../db/pool.js'
import { env } from '../../../config/env.js'

export type MobileAppContext={businessUnitId:number;slug:string;config:Record<string,unknown>}
export async function resolveMobileApp(slug:string):Promise<MobileAppContext|null>{
 const rows=await query<any>(`SELECT id,mobile_app_slug,COALESCE(mobile_app_config,'{}'::jsonb) config FROM human_resource.business_units WHERE mobile_app_enabled=TRUE AND mobile_app_slug=$1 LIMIT 1`,[slug])
 return rows[0]?{businessUnitId:Number(rows[0].id),slug:rows[0].mobile_app_slug,config:rows[0].config}:null
}
export async function requireLocation(context:MobileAppContext,locationId:number){
 const rows=await query<any>(`SELECT l.*,c.id catalogue_id FROM human_resource.locations l LEFT JOIN inventory.catalogues c ON c.location_id=l.id WHERE l.id=$1 AND l.business_unit_id=$2 AND l.status_id=1 LIMIT 1`,[locationId,context.businessUnitId])
 return rows[0]??null
}
export type CustomerClaims={sub:string;sid:string;entity_id:number;business_unit_id:number;type:'customer'}
export async function authenticateCustomer(req:FastifyRequest,context:MobileAppContext):Promise<CustomerClaims>{
 const raw=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):''
 if(env.CUSTOMER_JWT_SECRET.length<32||!raw) throw Object.assign(new Error('Sesión requerida'),{statusCode:401,code:'AUTH_REQUIRED'})
 let claims:CustomerClaims
 try{claims=jwt.verify(raw,env.CUSTOMER_JWT_SECRET,{issuer:'comandpos',audience:'pizza-getto-app'}) as CustomerClaims}catch{throw Object.assign(new Error('Sesión inválida'),{statusCode:401,code:'INVALID_SESSION'})}
 if(claims.type!=='customer'||Number(claims.business_unit_id)!==context.businessUnitId) throw Object.assign(new Error('Acceso denegado'),{statusCode:403,code:'FORBIDDEN'})
 const active=await query(`SELECT 1 FROM finances.customer_mobile_sessions WHERE id=$1 AND entity_id=$2 AND revoked_at IS NULL AND expires_at>now()`,[claims.sid,claims.entity_id])
 if(!active.length) throw Object.assign(new Error('Sesión expirada'),{statusCode:401,code:'SESSION_EXPIRED'})
 return claims
}
