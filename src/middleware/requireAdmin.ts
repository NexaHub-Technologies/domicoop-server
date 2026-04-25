import Elysia from "elysia";

export const requireAdmin = new Elysia({ name: "requireAdmin" })
  .derive({ as: "scoped" }, ({ set, ...ctx }: any) => {
    const role = ctx.role as string;
    if (role !== "admin") {
      set.status = 403;
      throw new Error("Admin access required");
    }
    return {};
  });
