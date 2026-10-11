import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type MemoryTable = Record<string, unknown>[];
type Auth = typeof import("@/lib/auth").auth;

const BASE_URL = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  db: {} as Record<
    "user" | "session" | "account" | "verification",
    MemoryTable
  >,
}));

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { prismaAdapter: () => memoryAdapter(mocks.db) };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { username: string } }) =>
        mocks.db.user.find((user) => user.username === where.username) ?? null,
    },
  },
}));

const githubProfile = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  email: "octocat@github.example",
  avatar_url: "https://avatars.githubusercontent.com/u/583231",
};

async function fakeGitHubFetch(input: RequestInfo | URL) {
  const url = input instanceof Request ? input.url : String(input);

  switch (url) {
    case "https://github.com/login/oauth/access_token":
      return Response.json({
        access_token: "gho_test",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    case "https://api.github.com/user":
      return Response.json(githubProfile);
    case "https://api.github.com/user/emails":
      return Response.json([
        { email: githubProfile.email, primary: true, verified: true },
      ]);
    default:
      throw new Error(`Unexpected request to ${url}`);
  }
}

// auth 模块在加载时读取环境变量，切换模式需要清掉模块缓存后重新导入。
async function loadAuth(authMode: "production" | "self-hosted") {
  vi.resetModules();
  vi.stubEnv("AUTH_MODE", authMode);
  vi.stubEnv("BETTER_AUTH_URL", BASE_URL);
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-with-at-least-32-characters");
  vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret");
  const { auth } = await import("@/lib/auth");
  return auth;
}

function toCookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signInWithGitHub(auth: Auth) {
  const signIn = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "/zh/usage",
        newUserCallbackURL: "/zh/settings/account",
      }),
    }),
  );
  const { url } = (await signIn.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");

  return auth.handler(
    new Request(
      `${BASE_URL}/api/auth/callback/github?code=test-code&state=${state}`,
      { headers: { cookie: toCookieHeader(signIn) } },
    ),
  );
}

beforeEach(() => {
  mocks.db.user = [];
  mocks.db.session = [];
  mocks.db.account = [];
  mocks.db.verification = [];
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GitHub OAuth sign-in", () => {
  let auth: Auth;

  // 首次加载 better-auth 依赖树较慢，可能超过单个用例 5 秒的超时。
  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeGitHubFetch);
    auth = await loadAuth("production");
  }, 60_000);

  it("creates a new user and sends them to set up a username", async () => {
    const callback = await signInWithGitHub(auth);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/zh/settings/account");
    expect(mocks.db.user).toEqual([
      expect.objectContaining({
        email: githubProfile.email,
        username: "octocat",
        usernameNeedsSetup: true,
        usernameAutoAdjusted: false,
      }),
    ]);

    const session = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie: toCookieHeader(callback) },
      }),
    );
    await expect(session.json()).resolves.toMatchObject({
      user: { username: "octocat", usernameNeedsSetup: true },
    });
  });

  it("clears the setup flag once the new user picks a username", async () => {
    const callback = await signInWithGitHub(auth);
    const update = await auth.handler(
      new Request(`${BASE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: toCookieHeader(callback),
        },
        body: JSON.stringify({ name: "The Octocat", username: "the.octocat" }),
      }),
    );

    expect(update.status).toBe(200);
    expect(mocks.db.user).toEqual([
      expect.objectContaining({
        username: "the.octocat",
        usernameNeedsSetup: false,
      }),
    ]);
  });

  it("sends a returning user to the usage page", async () => {
    await signInWithGitHub(auth);
    const callback = await signInWithGitHub(auth);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/zh/usage");
    expect(mocks.db.user).toHaveLength(1);
  });
});

describe("email sign-up", () => {
  let auth: Auth;

  beforeAll(async () => {
    auth = await loadAuth("self-hosted");
  }, 60_000);

  it("keeps the username the user chose", async () => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          password: "correct-horse-battery",
          username: "Alice_01",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.db.user).toEqual([
      expect.objectContaining({
        username: "alice_01",
        usernameNeedsSetup: false,
        usernameAutoAdjusted: false,
      }),
    ]);
  });

  it("rejects an oversized email before it seeds username generation", async () => {
    // Without a username, the local part seeds generation. Its separator trim
    // used to take seconds on a long `_._` run that does not reach the end.
    const started = performance.now();
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          name: "Mallory",
          email: `a${"_.".repeat(100_000)}b@example.com`,
          password: "correct-horse-battery",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(mocks.db.user).toHaveLength(0);
  });
});

describe("update-user", () => {
  let auth: Auth;

  async function signUp() {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          password: "correct-horse-battery",
        }),
      }),
    );
    expect(response.status).toBe(200);
    return toCookieHeader(response);
  }

  function updateUser(cookie: string, body: Record<string, unknown>) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/update-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  beforeAll(async () => {
    auth = await loadAuth("self-hosted");
  }, 60_000);

  it("refuses to let a client set the username flags", async () => {
    const cookie = await signUp();
    expect(mocks.db.user[0]).toMatchObject({ usernameNeedsSetup: true });

    expect(
      (await updateUser(cookie, { usernameAutoAdjusted: true })).status,
    ).toBe(400);
    // A falsy value is dropped rather than written.
    expect(
      (await updateUser(cookie, { name: "Alice", usernameNeedsSetup: false }))
        .status,
    ).toBe(200);
    expect(mocks.db.user[0]).toMatchObject({
      usernameNeedsSetup: true,
      usernameAutoAdjusted: false,
    });
  });

  it("rejects an arbitrary profile image and an oversized name", async () => {
    const cookie = await signUp();

    expect(
      (await updateUser(cookie, { image: "https://tracker.example/p.gif" }))
        .status,
    ).toBe(400);
    expect((await updateUser(cookie, { name: "x".repeat(51) })).status).toBe(
      400,
    );
    expect(mocks.db.user[0]).toMatchObject({ name: "Alice" });
    expect(mocks.db.user[0]?.image ?? null).toBeNull();
  });
});

describe("GitLab OAuth account linking", () => {
  let auth: Auth;
  let gitlabProfile: Record<string, unknown> = {};

  async function fakeProviderFetch(input: RequestInfo | URL) {
    const url = input instanceof Request ? input.url : String(input);

    switch (url) {
      case "https://gitlab.example.com/oauth/token":
        return Response.json({ access_token: "gl_test", token_type: "bearer" });
      case "https://gitlab.example.com/api/v4/user":
        return Response.json(gitlabProfile);
      default:
        return fakeGitHubFetch(input);
    }
  }

  async function signInWithGitLab() {
    const signIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          providerId: "gitlab",
          callbackURL: "/zh/usage",
          errorCallbackURL: "/zh/login",
        }),
      }),
    );
    const { url } = (await signIn.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");

    return auth.handler(
      new Request(
        `${BASE_URL}/api/auth/oauth2/callback/gitlab?code=test-code&state=${state}`,
        { headers: { cookie: toCookieHeader(signIn) } },
      ),
    );
  }

  async function sessionUserId(response: Response) {
    const session = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie: toCookieHeader(response) },
      }),
    );
    const body = (await session.json()) as { user?: { id: string } } | null;
    return body?.user?.id ?? null;
  }

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeProviderFetch);
    vi.stubEnv("GITLAB_BASE_URL", "https://gitlab.example.com");
    vi.stubEnv("GITLAB_CLIENT_ID", "gitlab-client-id");
    vi.stubEnv("GITLAB_CLIENT_SECRET", "gitlab-client-secret");
    auth = await loadAuth("production");
  }, 60_000);

  it("does not hand an existing account to an unconfirmed GitLab email", async () => {
    const victim = await sessionUserId(await signInWithGitHub(auth));
    expect(victim).not.toBeNull();

    gitlabProfile = {
      id: 999,
      username: "mallory",
      name: "Mallory",
      email: githubProfile.email,
      confirmed_at: null,
    };
    const callback = await signInWithGitLab();

    expect(await sessionUserId(callback)).toBeNull();
    expect(
      mocks.db.account.filter((account) => account.providerId === "gitlab"),
    ).toEqual([]);
  });

  it("still links a GitLab account whose email GitLab confirmed", async () => {
    const owner = await sessionUserId(await signInWithGitHub(auth));

    gitlabProfile = {
      id: 1000,
      username: "octocat",
      name: "The Octocat",
      email: githubProfile.email,
      confirmed_at: "2026-01-01T00:00:00Z",
    };
    const callback = await signInWithGitLab();

    expect(await sessionUserId(callback)).toBe(owner);
  });
});

describe("Linux.do OAuth sign-up", () => {
  let auth: Auth;
  let linuxdoProfile: Record<string, unknown> = {};

  async function fakeLinuxdoFetch(input: RequestInfo | URL) {
    const url = input instanceof Request ? input.url : String(input);

    switch (url) {
      case "https://connect.linux.do/oauth2/token":
        return Response.json({ access_token: "ld_test", token_type: "bearer" });
      case "https://connect.linux.do/api/user":
        return Response.json(linuxdoProfile);
      default:
        throw new Error(`Unexpected request to ${url}`);
    }
  }

  async function signInWithLinuxdo() {
    const signIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          providerId: "linuxdo",
          callbackURL: "/zh/usage",
          errorCallbackURL: "/zh/login",
        }),
      }),
    );
    const { url } = (await signIn.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");

    return auth.handler(
      new Request(
        `${BASE_URL}/api/auth/oauth2/callback/linuxdo?code=test-code&state=${state}`,
        { headers: { cookie: toCookieHeader(signIn) } },
      ),
    );
  }

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeLinuxdoFetch);
    vi.stubEnv("LINUXDO_CLIENT_ID", "linuxdo-client-id");
    vi.stubEnv("LINUXDO_CLIENT_SECRET", "linuxdo-client-secret");
    auth = await loadAuth("production");
  }, 60_000);

  it("signs up a user whose Linux.do username has a dash", async () => {
    // Validation of the raw `username` used to reject this before the create
    // hook ran, and the callback bounced back to the login page.
    linuxdoProfile = {
      id: 42,
      username: "foo-bar",
      name: "",
      email: "foo@example.com",
    };

    const callback = await signInWithLinuxdo();

    expect(callback.headers.get("location")).toBe("/zh/usage");
    expect(mocks.db.user).toEqual([
      expect.objectContaining({
        name: "foo-bar",
        username: "foo.bar",
        usernameNeedsSetup: false,
      }),
    ]);
  });
});
