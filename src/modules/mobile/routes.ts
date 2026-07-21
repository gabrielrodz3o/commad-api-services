import type { FastifyInstance } from 'fastify'
import { mobileAppRoutes } from './app/routes.js'
import {mobileAuthRoutes} from './auth/routes.js'
import {mobileCustomerRoutes} from './customer/routes.js'
import {mobileCatalogRoutes} from './catalog/routes.js'
import {mobileOrderRoutes} from './orders/routes.js'
export function mobileRoutes(app:FastifyInstance){app.get('/v1/mobile/status',async()=>({success:true,service:'mobile-api',version:'v1'}));mobileAppRoutes(app);mobileAuthRoutes(app);mobileCustomerRoutes(app);mobileCatalogRoutes(app);mobileOrderRoutes(app)}
