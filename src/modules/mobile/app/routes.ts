import type { FastifyInstance } from "fastify";
import { getMobileApp } from "./repository.js";
export function mobileAppRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>(
    "/v1/mobile/apps/:slug/bootstrap",
    async (req, reply) => {
      const data = await getMobileApp(req.params.slug);
      if (!data)
        return reply
          .code(404)
          .send({
            success: false,
            code: "APP_NOT_FOUND",
            message: "Aplicación no disponible",
          });
      return {
        success: true,
        data: {
          business: {
            id: data.id,
            name: data.description_long,
            color: data.color,
            config: data.mobile_app_config,
          },
          campaigns: data.campaigns,
          locations: data.locations.map((x: any) => ({
            ...x,
            channels: { delivery: !!x.use_delivery, pickup: !!x.use_pickup },
          })),
        },
      };
    },
  );
}
