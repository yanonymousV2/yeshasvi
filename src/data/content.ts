// Single source of truth for the homepage text; rendered to HTML at build time.
// No employer or product names here on purpose.
import { url } from '../lib/url';

export const content = {
  name: 'Yeshasvi',
  role: 'senior backend engineer',
  location: 'Hyderabad, India',
  email: 'workwithyeshasvi@gmail.com',
  linkedin: 'https://linkedin.com/in/yeshasvi-00215b191',
  linkedinLabel: 'in/yeshasvi-00215b191',
  github: 'https://github.com/yanonymousV2',
  githubLabel: 'yanonymousV2',
  phone: '+917013849726',
  phoneLabel: '+91 70138 49726',
  credly: 'https://www.credly.com/badges/d9d5f9e0-c823-4330-acf0-77ac8d9e5507',
  badge: url('/aws-saa.png'),
  logo: url('/alien-64.png'),
  blog: url('/blog/'),

  lede: "Hi, <strong>you're the request.</strong> I'll route you through a backend, the kind I build for a living, and introduce myself at every hop.",

  hops: [
    { id: 'client',   name: 'client',        sub: 'you',           ms: 0,  title: 'GET /yeshasvi' },
    { id: 'dns',      name: 'dns',           sub: 'who I am',      ms: 12, title: 'First, resolving <em>who I am.</em>' },
    { id: 'lb',       name: 'load balancer', sub: 'what I do',     ms: 1,  title: 'Routing you to <em>a healthy node.</em>' },
    { id: 'waf',      name: 'waf',           sub: 'security',      ms: 3,  title: "Checking you're <em>not malicious.</em>" },
    { id: 'gateway',  name: 'gateway',       sub: 'experience',    ms: 1,  title: "Routing table: <em>where I've worked.</em>" },
    { id: 'services', name: 'services',      sub: 'work',          ms: 42, title: "The services <em>I've built.</em>" },
    { id: 'queue',    name: 'queue',         sub: 'side projects', ms: 0,  title: 'Things I do <em>asynchronously.</em>' },
    { id: 'db',       name: 'database',      sub: 'stack',         ms: 7,  title: 'Querying <em>my stack.</em>' },
    { id: 'response', name: '200 OK',        sub: 'contact',       ms: 2,  title: "You made it. Let's build something that <em>stays up.</em>" },
  ],

  dns: {
    records: [
      ['A', '"Hyderabad, India"'],
      ['TXT', '"senior backend engineer"'],
      ['TXT', '"3+ years in production"'],
      ['TXT', '"go · python · grpc"'],
      ['CNAME', 'aws-certified-architect.'],
    ],
    text: [
      'I build distributed systems in <strong>Go and Python</strong>, and I own them end to end: architecture, security, deployment and observability.',
      "I work as an independent contributor on architecture and system design, and I write the code that backs it up, on infrastructure that <strong>holds up at scale</strong>.",
      "That CNAME is real: I'm an <strong>AWS Certified Solutions Architect – Associate</strong>.",
    ],
  },

  lb: {
    sub: "I work as an independent contributor. Depending on the day, I'm one of three people, and all three pass health checks.",
    nodes: [
      { id: 'node-1', title: 'The architect', text: "Designs systems end to end: where the service boundaries go, how data flows, and what happens when things fail.", tags: ["service boundaries", "data flow", "failure modes"] },
      { id: 'node-2', title: 'The system designer', text: "Works through the trade-offs behind each design, like moving service calls from REST to gRPC or bringing Go into a Python codebase.", tags: ["REST → gRPC", "Python → Go", "sync → async"] },
      { id: 'node-3', title: 'The builder', text: "Writes the code behind those designs, from backend services to a desktop app that ships on three operating systems.", tags: ["Go", "Python", "Rust · Tauri"] },
    ],
    foot: [['upstream capacity', '10K+ concurrent users'], ['uptime', '3+ years in production']],
  },

  waf: {
    sub: 'Security is part of the design, not a patch. I studied IT with <strong>honours in Security &amp; Privacy</strong>, and these are the rules I build by. Go ahead, try to get past them.',
    rules: [
      { key: 'edge', code: 'edge.waf', text: 'API Gateway and WAF in front of production traffic, blocking 10K+ malicious requests a month.' },
      { key: 'session', code: 'session.httponly', text: "Session auth on HTTPOnly cookies, so an XSS bug can't steal anyone's tokens." },
      { key: 'tls', code: 'tls.terminate', text: 'TLS terminated at NGINX and HAProxy. Nothing travels in plain text.' },
      { key: 'rate', code: 'rate.limit', text: 'Redis-backed rate limiting keeps abusive clients from starving everyone else.' },
      { key: 'detect', code: 'detect.respond', text: 'Wazuh SIEM for detection, and ClamAV scanning on anything users upload.' },
    ],
  },

  // Timeline only: role + dates. Details live in the services hop and on LinkedIn.
  routes: [
    { path: '/now', role: 'Senior Software Engineer', where: 'product company · Hyderabad', when: 'May 2026 → now' },
    { path: '/2025', role: 'Software Engineer', where: 'same company, promoted to senior', when: 'Feb 2025 → May 2026' },
    { path: '/2023', role: 'Software Engineer', where: 'previous company · Hyderabad', when: 'Jul 2023 → Jan 2025' },
    { path: '/edu', role: 'B.Tech, Information Technology', where: 'Symbiosis Institute of Technology, Pune · honours in Security &amp; Privacy', when: '2019 → 2023' },
  ],
  routesSub: 'Each route maps to a role. What I actually built is in the next hop.',

  services: [
    { id: 'core', tab: 'core-svc', badge: 'Architecture · system design', title: 'Monolith → Go microservices, talking over gRPC',
      text: 'I designed the split of a Python monolith into function-based services, brought Go in for the hot paths, then moved service-to-service calls from REST to gRPC.',
      chips: [['2s → 400ms', 'between services'], ['3–5×', 'throughput and memory with Go']],
      tryThis: 'add more hops or a bigger payload and watch the gap grow. The cost of each call compounds across the chain.',
      widget: 'grpc' },
    { id: 'desk', tab: 'desktop-svc', badge: 'Architect · owner', title: 'One desktop app, three operating systems',
      text: 'A cross-platform desktop app with a large web backend behind it. I architected and shipped the app and own the whole backend.',
      chips: [['−90%', 'release time'], ['−50%', 'API response time'], ['3', 'operating systems']],
      tags: ['Tauri', 'Rust', 'FastAPI', 'Azure Blob', 'Loki', 'Grafana'],
      caseRows: [
        ['Challenge', 'Ship one app to macOS, Windows and Linux, keep every install up to date securely, and back it with a large, reliable API.'],
        ['Built', 'A Tauri app with <b>over-the-air updates secured by Azure SAS tokens</b>, plus the web backend it talks to.'],
        ['Tuned', 'Indexing and query optimisation took responses <b>from 5s to 2.5s</b>. Retries and circuit breakers keep external integrations from taking the app down.'],
        ['Shipped', 'Automated builds, secret management and auto-updates for all three OSes, cutting release time by <b>over 90%</b>.'],
        ['Watched', 'Loki and Prometheus in Grafana, so incidents get found and fixed <b>30% faster</b>.'],
      ] },
    { id: 'res', tab: 'resilience-svc', badge: 'Playground', title: 'Retries vs a circuit breaker',
      text: "When a downstream service goes down, blind retries multiply the load on it and make every user sit through timeouts. A circuit breaker spots the failures, answers immediately with a fallback, then sends an occasional test request until the service recovers. I've added both to production integrations.",
      tryThis: 'break the downstream, then switch between the two strategies and watch the load and wait time.',
      widget: 'cb' },
  ],
  alsoRunning: ['workflow engine', 'Redis caching', 'NGINX / HAProxy', 'Loki · Prometheus · Grafana', 'event-driven async jobs'],

  sage: {
    title: 'sage: ask your machine anything',
    text: 'A CLI that answers system questions using real data from your machine. It works out which read-only commands to run, shows them to you for approval, runs them, and explains the output in plain English. It works with Ollama, Claude or OpenAI.',
    install: 'curl -fsSL https://raw.githubusercontent.com/yanonymousV2/sage/main/install.sh | sh',
    repo: 'https://github.com/yanonymousV2/sage',
  },
  papers: [
    { badge: 'IEEE ICCUBEA · 2023', title: 'Network Traffic Analyzer', text: 'Network traffic analysis for monitoring and security assessment, built with Python and NetworkX.', link: 'https://ieeexplore.ieee.org/document/10392223', linkLabel: 'Read the paper ↗' },
    { badge: 'Springer CCIS', title: 'CDR/IPDR Fraud Detection', text: 'Analytics on telecom call and IP detail records to detect anomalies and fraud patterns.', link: 'https://link.springer.com/chapter/10.1007/978-3-031-59100-63', linkLabel: 'Read the chapter ↗' },
  ],

  stack: [
    ['languages', ['Go', 'Python', 'Rust', 'Bash', 'PowerShell']],
    ['backend', ['gRPC', 'REST', 'Gin', 'Go Kit', 'FastAPI', 'Flask', 'Tauri']],
    ['data & messaging', ['MongoDB', 'PostgreSQL', 'Redis', 'ActiveMQ']],
    ['cloud & infra', ['AWS · S3 · EC2 · IAM · VPC', 'Azure', 'Docker', 'Swarm', 'Kubernetes', 'NGINX', 'HAProxy', 'Linux']],
    ['observability & security', ['Grafana', 'Loki', 'Prometheus', 'API Gateway', 'WAF', 'Wazuh', 'ClamAV']],
    ['concepts', ['distributed systems', 'event-driven design', 'concurrency', 'database optimisation']],
  ],
  cert: { title: 'Solutions Architect – Associate', meta: 'Amazon Web Services · valid 2026–2029' },
};

export type Content = typeof content;
export const totalMs = content.hops.reduce((sum, h) => sum + h.ms, 0);
export const hop = (id: string) => content.hops.findIndex((h) => h.id === id);
