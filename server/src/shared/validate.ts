import { HttpError } from './http.ts';

// A small JSON Schema subset, used for request bodies and for the assistant's tool arguments.
export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: 'string'; minLength?: number; maxLength?: number; pattern?: string; enum?: string[]; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'number'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string };

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`];
      const obj = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) errors.push(`${path}.${key} is required`);
      }
      for (const [key, child] of Object.entries(obj)) {
        const prop = schema.properties[key];
        if (!prop) {
          if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
          continue;
        }
        if (child === undefined || (child === null && !(schema.required ?? []).includes(key))) continue;
        errors.push(...validate(prop, child, `${path}.${key}`));
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      const errors: string[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} items`);
      value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
      return errors;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path} must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path} must be at least ${schema.minLength} characters`];
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path} must be at most ${schema.maxLength} characters`];
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return [`${path} has an invalid format`];
      if (schema.enum !== undefined && !schema.enum.includes(value)) return [`${path} must be one of ${schema.enum.join(', ')}`];
      return [];
    }
    case 'integer':
    case 'number': {
      const valid = schema.type === 'integer' ? Number.isInteger(value) : typeof value === 'number' && Number.isFinite(value);
      if (!valid) return [`${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`];
      const n = value as number;
      if (schema.minimum !== undefined && n < schema.minimum) return [`${path} must be >= ${schema.minimum}`];
      if (schema.maximum !== undefined && n > schema.maximum) return [`${path} must be <= ${schema.maximum}`];
      return [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} must be a boolean`];
  }
}

export function parseBody<T>(schema: Schema, body: unknown): T {
  const value = body === undefined && schema.type === 'object' ? {} : body;
  const errors = validate(schema, value);
  if (errors.length > 0) throw new HttpError(400, 'invalid_request', errors[0]!, { errors });
  return value as T;
}
