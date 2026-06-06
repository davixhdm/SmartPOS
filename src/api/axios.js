// api/axios.js
import axios from "axios";

// ========== CONFIGURATION ==========
const PRIMARY_URL = import.meta.env.VITE_API_BASE_URL || "https://smartpos-server.pxxl.click/api";
const BACKUP_URL = import.meta.env.VITE_API_BASE_URL_BACKUP || "https://smartpos-server-api.onrender.com/api";

const API_SERVERS = [
  { url: PRIMARY_URL, name: "Primary", type: "primary" },
  { url: BACKUP_URL, name: "Backup", type: "backup" },
];

// ========== STATE MANAGEMENT ==========
let currentServerIndex = 0;
let serverHealthy = [true, true];
let requestQueue = new Map(); // Prevent duplicate requests
let pendingRetries = new Map(); // Track retries per request
let lastHealthCheck = 0;
let isHealthChecking = false;
let activeRequestsCount = 0;
let failoverInProgress = false;

const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const HEALTH_CHECK_TIMEOUT = 2000; // 2 seconds
const FAILOVER_DELAY = 50; // 50ms micro-delay for failover

// ========== DEDUPLICATION HELPERS ==========
const getRequestKey = (config) => {
  const { method, url, params, data } = config;
  const stringifiedData = data ? JSON.stringify(data) : '';
  const stringifiedParams = params ? JSON.stringify(params) : '';
  return `${method}-${url}-${stringifiedParams}-${stringifiedData}`;
};

const addToQueue = (key, promise) => {
  if (!requestQueue.has(key)) {
    requestQueue.set(key, promise);
    promise.finally(() => {
      if (requestQueue.get(key) === promise) {
        requestQueue.delete(key);
      }
    });
  }
  return requestQueue.get(key);
};

// ========== SILENT BACKGROUND HEALTH CHECK ==========
const checkServerHealth = async (serverUrl, index) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
    
    await axios.get(`${serverUrl.replace(/\/api$/, '')}/api/health`, {
      signal: controller.signal,
      timeout: HEALTH_CHECK_TIMEOUT,
      headers: { 'X-Health-Check': 'true', 'X-Silent': 'true' }
    });
    
    clearTimeout(timeoutId);
    serverHealthy[index] = true;
    return true;
  } catch (error) {
    serverHealthy[index] = false;
    return false;
  }
};

const backgroundHealthCheck = async () => {
  if (isHealthChecking) return;
  
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) return;
  
  isHealthChecking = true;
  lastHealthCheck = now;
  
  try {
    // Check both servers in parallel
    const results = await Promise.all([
      checkServerHealth(API_SERVERS[0].url, 0),
      checkServerHealth(API_SERVERS[1].url, 1)
    ]);
    
    const currentHealthy = serverHealthy[currentServerIndex];
    const otherIndex = 1 - currentServerIndex;
    const otherHealthy = serverHealthy[otherIndex];
    
    // Auto-switch if current is unhealthy and other is healthy
    if (!currentHealthy && otherHealthy && !failoverInProgress) {
      failoverInProgress = true;
      
      // Wait for any in-flight requests to complete
      if (activeRequestsCount > 0) {
        await new Promise(resolve => {
          const checkInterval = setInterval(() => {
            if (activeRequestsCount === 0) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 10);
        });
      }
      
      // Perform silent switch
      const oldIndex = currentServerIndex;
      currentServerIndex = otherIndex;
      console.log(`[Background] Switched to ${API_SERVERS[currentServerIndex].name}`);
      
      setTimeout(() => { failoverInProgress = false; }, 100);
    }
    // Switch back if current is slower but healthy
    else if (currentHealthy && otherHealthy && !failoverInProgress) {
      // Test latencies for optimal routing
      const start1 = performance.now();
      await checkServerHealth(API_SERVERS[0].url, 0);
      const latency1 = performance.now() - start1;
      
      const start2 = performance.now();
      await checkServerHealth(API_SERVERS[1].url, 1);
      const latency2 = performance.now() - start2;
      
      // Switch to faster server if significantly faster (>30ms difference)
      if (Math.abs(latency1 - latency2) > 30) {
        const fasterIndex = latency1 < latency2 ? 0 : 1;
        if (fasterIndex !== currentServerIndex) {
          currentServerIndex = fasterIndex;
          console.log(`[Background] Switched to faster server: ${API_SERVERS[currentServerIndex].name}`);
        }
      }
    }
  } catch (error) {
    // Silent fail - no user impact
  } finally {
    isHealthChecking = false;
  }
};

// Start background health checks
backgroundHealthCheck();
setInterval(backgroundHealthCheck, HEALTH_CHECK_INTERVAL);

// ========== AXIOS INSTANCE ==========
const api = axios.create({
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

// ========== REQUEST INTERCEPTOR ==========
api.interceptors.request.use(
  async (config) => {
    // Track active requests
    activeRequestsCount++;
    
    // Set base URL instantly (no waiting)
    config.baseURL = API_SERVERS[currentServerIndex].url;
    config._retryCount = config._retryCount || 0;
    config._requestKey = getRequestKey(config);
    config._startTime = Date.now();
    
    // Prevent duplicate in-flight requests
    if (config._retryCount === 0 && config.method === 'get') {
      const existingPromise = requestQueue.get(config._requestKey);
      if (existingPromise) {
        activeRequestsCount--;
        throw { __isDuplicate: true, existingPromise };
      }
    }
    
    // Add auth token
    const token = localStorage.getItem('smartpos_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    
    return config;
  },
  (error) => {
    activeRequestsCount--;
    return Promise.reject(error);
  }
);

// ========== RESPONSE INTERCEPTOR ==========
api.interceptors.response.use(
  (response) => {
    activeRequestsCount--;
    // Mark server as healthy on success
    serverHealthy[currentServerIndex] = true;
    return response.data;
  },
  async (error) => {
    activeRequestsCount--;
    
    // Handle duplicate request bypass
    if (error?.__isDuplicate) {
      return error.existingPromise;
    }
    
    const config = error.config;
    
    // ========== NON-RETRYABLE ERRORS ==========
    if (
      !config ||
      config._retryCount >= 1 || // Only retry ONCE maximum
      error.code === 'ECONNABORTED' && config._retryCount > 0,
      error.response?.status === 401 ||
      error.response?.status === 403 ||
      error.response?.status === 404 ||
      error.response?.status === 422 ||
      config.method !== 'get' // Only retry GET requests to avoid duplicates
    ) {
      // Handle auth errors
      if (error.response?.status === 401) {
        const path = window.location.hash || window.location.pathname;
        if (!path.includes('/login')) {
          localStorage.removeItem('smartpos_token');
          localStorage.removeItem('smartpos_user');
          localStorage.removeItem('smartpos_clientId');
          window.location.href = '/login';
        }
      }
      return Promise.reject(error.response?.data || error);
    }
    
    // ========== SILENT FAILOVER ==========
    const originalServerIndex = currentServerIndex;
    const otherIndex = 1 - currentServerIndex;
    
    // Check if other server is healthy
    let otherServerHealthy = serverHealthy[otherIndex];
    
    // If health unknown, do quick check
    if (!otherServerHealthy && !failoverInProgress) {
      const healthResult = await checkServerHealth(API_SERVERS[otherIndex].url, otherIndex);
      otherServerHealthy = healthResult;
    }
    
    // Attempt failover if other server is healthy
    if (otherServerHealthy && !failoverInProgress) {
      failoverInProgress = true;
      
      // Mark current as unhealthy
      serverHealthy[currentServerIndex] = false;
      
      // Switch server
      currentServerIndex = otherIndex;
      console.log(`[Failover] Switched to ${API_SERVERS[currentServerIndex].name}`);
      
      // Micro delay for failover (user won't notice)
      await new Promise(resolve => setTimeout(resolve, FAILOVER_DELAY));
      
      // Retry the request exactly once on new server
      config._retryCount = 1;
      config.baseURL = API_SERVERS[currentServerIndex].url;
      
      failoverInProgress = false;
      
      // Execute retry
      return api(config);
    }
    
    // If both servers failed, return error
    if (!serverHealthy[0] && !serverHealthy[1]) {
      console.error('[Critical] Both servers unavailable');
    }
    
    return Promise.reject(error.response?.data || error);
  }
);

// ========== PUBLIC HELPERS ==========
export const getCurrentServer = () => ({
  url: API_SERVERS[currentServerIndex].url,
  name: API_SERVERS[currentServerIndex].name,
  healthy: serverHealthy[currentServerIndex]
});

export const getServerStatus = () => ({
  primary: { healthy: serverHealthy[0], url: API_SERVERS[0].url },
  backup: { healthy: serverHealthy[1], url: API_SERVERS[1].url },
  active: API_SERVERS[currentServerIndex].name
});

export default api;