import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(resource: string, id: string) {
    super(`${resource} '${id}' was not found`);
    this.name = 'NotFoundError';
  }
}

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (hasZodFastifySchemaValidationErrors(error)) {
    void reply.status(400).send({
      error: 'ValidationError',
      message: 'Request validation failed',
      issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
    });
    return;
  }

  if (error instanceof NotFoundError) {
    void reply.status(404).send({ error: 'NotFound', message: error.message });
    return;
  }

  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, 'Unhandled error');
    void reply.status(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred' });
    return;
  }

  void reply.status(statusCode).send({ error: error.name, message: error.message });
}
