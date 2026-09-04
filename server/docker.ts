import Docker from 'dockerode';
import type { ConnectionConfig, ContainerInfo, CreateContainerRequest, Dialect } from '../src/shared/types';

const LABEL_MANAGED = 'dbviz.managed';
const LABEL_DIALECT = 'dbviz.dialect';
/** Host the *client* should use to reach published database ports (host.docker.internal when the app itself runs in Docker). */
export const DEFAULT_DB_HOST = process.env.DEFAULT_DB_HOST ?? '127.0.0.1';

let docker: Docker | null = null;

/** Lazily construct the client so a missing daemon only fails the Docker endpoints. */
export function getDocker(): Docker {
  if (docker) return docker;
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('tcp://')) {
    const u = new URL(host);
    docker = new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  } else if (host && host.startsWith('unix://')) {
    docker = new Docker({ socketPath: host.replace('unix://', '') });
  } else {
    docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
  }
  return docker;
}

export async function dockerStatus(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const v = await getDocker().version();
    return { available: true, version: `${v.Version} (API ${v.ApiVersion})` };
  } catch (e) {
    return { available: false, error: describeDockerError(e) };
  }
}

export function describeDockerError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT|ECONNREFUSED|EACCES/.test(msg)) {
    return `Docker daemon not reachable (${msg.split('\n')[0]}). Is Docker running, and does this user have access to the socket?`;
  }
  return msg;
}

function dialectFromImage(image: string): Dialect | null {
  const img = image.toLowerCase();
  if (img.includes('postgres') || img.includes('timescale') || img.includes('pgvector')) return 'postgresql';
  if (img.includes('mariadb') || img.includes('mysql')) return 'mariadb';
  return null;
}

function dbPort(dialect: Dialect): number {
  return dialect === 'postgresql' ? 5432 : 3306;
}

function envMap(env: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of env ?? []) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function toInfo(c: Docker.ContainerInfo): Promise<ContainerInfo> {
  const labels = c.Labels ?? {};
  const dialect = (labels[LABEL_DIALECT] as Dialect | undefined) ?? dialectFromImage(c.Image);
  const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
  let hostPort: number | null = null;
  if (dialect) {
    const p = c.Ports?.find((pp) => pp.PrivatePort === dbPort(dialect) && pp.PublicPort);
    hostPort = p?.PublicPort ?? null;
  }
  let connection: Partial<ConnectionConfig> | null = null;
  if (dialect) {
    try {
      const inspect = await getDocker().getContainer(c.Id).inspect();
      const env = envMap(inspect.Config?.Env);
      if (dialect === 'postgresql') {
        connection = {
          dialect,
          host: DEFAULT_DB_HOST,
          port: hostPort ?? 5432,
          user: env.POSTGRES_USER ?? 'postgres',
          password: env.POSTGRES_PASSWORD ?? '',
          database: env.POSTGRES_DB ?? env.POSTGRES_USER ?? 'postgres',
        };
      } else {
        const user = env.MARIADB_USER ?? env.MYSQL_USER ?? 'root';
        const password =
          env.MARIADB_USER || env.MYSQL_USER
            ? (env.MARIADB_PASSWORD ?? env.MYSQL_PASSWORD ?? '')
            : (env.MARIADB_ROOT_PASSWORD ?? env.MYSQL_ROOT_PASSWORD ?? '');
        connection = {
          dialect,
          host: DEFAULT_DB_HOST,
          port: hostPort ?? 3306,
          user,
          password,
          database: env.MARIADB_DATABASE ?? env.MYSQL_DATABASE ?? '',
        };
      }
    } catch {
      connection = null;
    }
  }
  return {
    id: c.Id,
    name,
    image: c.Image,
    state: c.State,
    status: c.Status,
    dialect,
    managed: labels[LABEL_MANAGED] === 'true',
    hostPort,
    connection,
  };
}

/** Containers that look like databases (managed by us, or running a postgres/mariadb/mysql image). */
export async function listDbContainers(): Promise<ContainerInfo[]> {
  const all = await getDocker().listContainers({ all: true });
  const dbs = all.filter((c) => c.Labels?.[LABEL_MANAGED] === 'true' || dialectFromImage(c.Image));
  const infos = await Promise.all(dbs.map(toInfo));
  return infos.sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name));
}

async function pullImage(image: string): Promise<void> {
  const d = getDocker();
  // Skip the pull when the image is already present.
  try {
    await d.getImage(image).inspect();
    return;
  } catch {
    /* not present */
  }
  const stream = await d.pull(image);
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function validateName(name: string): string {
  const n = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(n)) {
    throw new Error('Container name must be 1-63 characters: letters, digits, "_", "." or "-", starting with a letter or digit.');
  }
  return n;
}

export async function createDbContainer(req: CreateContainerRequest): Promise<{ container: ContainerInfo; connection: ConnectionConfig }> {
  const dialect: Dialect = req.dialect === 'mariadb' ? 'mariadb' : 'postgresql';
  const name = validateName(req.name || `dbviz-${dialect}`);
  const hostPort = Number(req.hostPort);
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error('Host port must be between 1 and 65535.');
  const database = (req.database || 'app').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Database name may only contain letters, digits and underscores.');
  const password = req.password || 'secret';
  const image = (req.image || (dialect === 'postgresql' ? 'postgres:16' : 'mariadb:11')).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(image)) throw new Error('Invalid image reference.');

  let env: string[];
  let user: string;
  if (dialect === 'postgresql') {
    user = (req.user || 'postgres').trim();
    env = [`POSTGRES_USER=${user}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${database}`];
  } else {
    user = (req.user || 'root').trim();
    env = [`MARIADB_ROOT_PASSWORD=${password}`, `MARIADB_DATABASE=${database}`];
    if (user !== 'root') env.push(`MARIADB_USER=${user}`, `MARIADB_PASSWORD=${password}`);
  }
  const containerPort = `${dbPort(dialect)}/tcp`;

  await pullImage(image);
  const d = getDocker();
  const container = await d.createContainer({
    Image: image,
    name,
    Env: env,
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_DIALECT]: dialect },
    ExposedPorts: { [containerPort]: {} },
    HostConfig: {
      PortBindings: { [containerPort]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });
  await container.start();

  const list = await d.listContainers({ all: true, filters: { id: [container.id] } });
  const info = await toInfo(list[0]);
  const connection: ConnectionConfig = { dialect, host: DEFAULT_DB_HOST, port: hostPort, user, password, database };
  return { container: info, connection };
}

export async function startContainer(id: string): Promise<void> {
  await getDocker().getContainer(id).start();
}

export async function stopContainer(id: string): Promise<void> {
  await getDocker().getContainer(id).stop({ t: 10 });
}

export async function removeContainer(id: string): Promise<void> {
  await getDocker().getContainer(id).remove({ force: true, v: true });
}
