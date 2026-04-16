export interface SwarmpitPort {
  containerPort: number;
  hostPort: number;
  protocol: string;
  mode: string;
}

export interface SwarmpitMount {
  containerPath: string;
  host: string;
  type: string;
  readOnly: boolean;
}

export interface SwarmpitEnvVar {
  name: string;
  value: string;
}

export interface SwarmpitLabel {
  name: string;
  value: string;
}

export interface SwarmpitSecretRef {
  id: string;
  secretName: string;
  secretTarget: string;
}

export interface SwarmpitConfigRef {
  id: string;
  configName: string;
  configTarget: string;
}

export interface SwarmpitRepository {
  name: string;
  tag: string;
  image: string;
  imageDigest: string;
}

export interface SwarmpitResources {
  cpu: number;
  memory: number;
}

export interface SwarmpitServiceStatus {
  tasks: { running: number; total: number };
  update: string;
  message: string;
}

export interface SwarmpitService {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  repository: SwarmpitRepository;
  serviceName: string;
  mode: string;
  replicas: number;
  state: string;
  status: SwarmpitServiceStatus;
  ports: SwarmpitPort[];
  mounts: SwarmpitMount[];
  networks: SwarmpitNetwork[];
  secrets: SwarmpitSecretRef[];
  configs: SwarmpitConfigRef[];
  variables: SwarmpitEnvVar[];
  labels: SwarmpitLabel[];
  command: string[] | null;
  stack: string;
  resources: {
    reservation: SwarmpitResources;
    limit: SwarmpitResources;
  };
}

export interface SwarmpitStack {
  stackName: string;
  stackFile: string;
  services: SwarmpitService[];
}

export interface SwarmpitNetwork {
  id: string;
  networkName: string;
  driver: string;
  scope: string;
  internal: boolean;
  stack: string;
}

export interface SwarmpitNode {
  id: string;
  nodeName: string;
  role: string;
  state: string;
  availability: string;
  address: string;
  engine: string;
}

export interface SwarmpitTask {
  id: string;
  taskName: string;
  serviceName: string;
  state: string;
  status: string;
  desiredState: string;
  createdAt: string;
  repository: SwarmpitRepository;
  nodeName: string;
  nodeId: string;
}

export interface SwarmpitVolume {
  volumeName: string;
  driver: string;
  scope: string;
  stack: string;
  mountpoint: string;
}

export interface SwarmpitLogEntry {
  line: string;
  timestamp?: string;
  taskName?: string;
}
