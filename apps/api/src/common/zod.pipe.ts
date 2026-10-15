import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

@Injectable()
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}

export function zod<T extends z.ZodType>(schema: T): ZodPipe<T> {
  return new ZodPipe(schema);
}
