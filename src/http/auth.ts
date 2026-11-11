import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação (ver ARCHITECTURE.md §Autenticação — seção 2 do enunciado).
 * Decisão: NÃO implementada neste desafio. O desenho previsto: um adapter OIDC que valida o JWT
 * emitido por um IdP externo (Keycloak/Zitadel) via JWKS e implementa `IdentityProviderPort`.
 * Os endpoints de saúde e /metrics não passam por este guard.
 */
export interface Principal {
  subject: string;
  roles: string[];
}

export interface IdentityProviderPort {
  /** Deve lançar UnauthorizedException (401) / ForbiddenException (403) quando o acesso for negado. */
  authenticate(authorizationHeader: string | undefined): Promise<Principal>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

/** No-op: aceita tudo. Troque por um adapter OIDC sem tocar nos controllers. */
@Injectable()
export class NoopIdentityProvider implements IdentityProviderPort {
  async authenticate(): Promise<Principal> {
    return { subject: 'anonymous', roles: [] };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(IDENTITY_PROVIDER) private readonly idp: IdentityProviderPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    req.principal = await this.idp.authenticate(req.headers.authorization);
    return true;
  }
}
