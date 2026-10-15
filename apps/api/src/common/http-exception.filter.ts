import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply } from "fastify";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === "string"
          ? { statusCode: status, error: exception.name, message: body }
          : { statusCode: status, error: exception.name, ...(body as Record<string, unknown>) };
      void reply.status(status).send(payload);
      return;
    }
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    void reply
      .status(500)
      .send({ statusCode: 500, error: "Internal Server Error", message: "Internal server error" });
  }
}
