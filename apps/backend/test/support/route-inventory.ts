// Every HTTP route of the running application with the metadata that decides who may call it, read from the same decorators the guards
// read. The conformance suites are generated from this list, so a new endpoint is covered the moment it exists (and a new endpoint that
// the suites do not know fails the suite instead of passing unnoticed).
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import {
  COURSE_ROLE_KEY,
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
  ROLES_KEY,
} from '../../src/common/decorators/auth.decorators.js';
import {
  RATE_LIMIT_KEY,
  type RateLimitMetadata,
} from '../../src/common/decorators/rate-limit.decorator.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteInfo {
  readonly method: HttpMethod;
  /** Without the `/api/v1` prefix, with `:params`. */
  readonly path: string;
  readonly key: string;
  readonly controller: string;
  readonly handlerName: string;
  readonly isPublic: boolean;
  readonly optionalAuth: boolean;
  readonly roles: readonly string[] | undefined;
  readonly courseRoles: readonly string[] | undefined;
  readonly rateLimit: RateLimitMetadata | undefined;
  readonly handler: (...args: never[]) => unknown;
  readonly controllerClass: new (...args: never[]) => unknown;
}

const METHODS: Record<number, HttpMethod | undefined> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

const join = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p.length > 0)
    .join('/');

export function routeInventory(app: INestApplication): RouteInfo[] {
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  const controllers = [...modules.values()].flatMap((module) => [
    ...module.controllers.values(),
  ]);
  for (const wrapper of controllers) {
    const instance = wrapper.instance as object | undefined;
    const controllerClass = wrapper.metatype as
      RouteInfo['controllerClass'] | null;
    if (!instance || !controllerClass) continue;
    const prefix = Reflect.getMetadata(PATH_METADATA, controllerClass) as
      string | string[] | undefined;
    const base = Array.isArray(prefix) ? prefix[0] : (prefix ?? '');
    for (const handlerName of scanner.getAllMethodNames(
      Object.getPrototypeOf(instance) as object,
    )) {
      const handler = (instance as Record<string, unknown>)[
        handlerName
      ] as RouteInfo['handler'];
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
        number | undefined;
      if (requestMethod === undefined) continue;
      const method = METHODS[requestMethod];
      if (!method) continue;
      const own = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      const path = join(base, Array.isArray(own) ? own[0] : (own ?? ''));
      const targets: [Function, Function] = [handler, controllerClass];
      routes.push({
        method,
        path,
        key: `${method.toUpperCase()} ${path}`,
        controller: controllerClass.name,
        handlerName,
        isPublic:
          reflector.getAllAndOverride<boolean | undefined>(
            IS_PUBLIC_KEY,
            targets,
          ) === true,
        optionalAuth:
          reflector.getAllAndOverride<boolean | undefined>(
            OPTIONAL_AUTH_KEY,
            targets,
          ) === true,
        roles: reflector.getAllAndOverride<string[] | undefined>(
          ROLES_KEY,
          targets,
        ),
        courseRoles: reflector.getAllAndOverride<string[] | undefined>(
          COURSE_ROLE_KEY,
          targets,
        ),
        rateLimit: reflector.getAllAndOverride<RateLimitMetadata | undefined>(
          RATE_LIMIT_KEY,
          targets,
        ),
        handler,
        controllerClass,
      });
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
