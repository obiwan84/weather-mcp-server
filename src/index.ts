import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-mcp/1.0";

// Create server instance
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
});

// Crear un buffer de logs
let logBuffer: string[] = [];

// Reemplazar console.error con una función personalizada
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  // Llamar a la función original
  originalConsoleError(...args);
  
  // Añadir al buffer con timestamp
  const timestamp = new Date().toISOString();
  const logMessage = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  logBuffer.push(`${timestamp}: ${logMessage}`);
  
  // Mantener el buffer a un tamaño razonable
  if (logBuffer.length > 100) {
    logBuffer.shift();
  }
};

// Modificar las herramientas para incluir logs en la respuesta
function wrapToolResponse(response: any) {
  // Solo incluir logs si hay alguno
  if (logBuffer.length === 0) {
    return response;
  }
  
  // Copiar los logs actuales y limpiar el buffer
  const currentLogs = [...logBuffer];
  logBuffer = [];
  
  // Añadir los logs a la respuesta
  const content = [...response.content];
  content.push({
    type: "text",
    text: "--- Debug Logs ---\n" + currentLogs.join('\n')
  });
  
  return {
    ...response,
    content
  };
}

// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segundos de timeout
    
    console.error(`Making request to: ${url}`);
    
    const response = await axios.get(url, { 
      headers, 
      signal: controller.signal,
      timeout: 10000
    });
    
    clearTimeout(timeoutId);
    
    return response.data as T;
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        console.error("Request timed out");
      } else {
        console.error("Axios error:", error.message);
        if (error.response) {
          console.error(`Status: ${error.response.status}, Data:`, error.response.data);
        }
      }
    } else if (error instanceof Error && error.name === 'AbortError') {
      console.error("Request aborted");
    } else {
      console.error("Error making NWS request:", error);
    }
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}

// Register weather tools
server.tool(
  "get-alerts",
  "Get weather alerts for a state",
  {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
    limit: z.number().min(1).max(50).optional().describe("Maximum number of alerts to return (default: 10)")
  },
  async ({ state, limit = 10 }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve alerts data",
          },
        ],
      };
    }

    const features = alertsData.features || [];
    if (features.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No active alerts for ${stateCode}`,
          },
        ],
      };
    }

    const formattedAlerts = features.slice(0, limit).map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;

    return wrapToolResponse({
      content: [
        {
          type: "text",
          text: alertsText,
        },
      ],
    });
  },
);

server.tool(
  "get-forecast",
  "Get weather forecast for a location",
  {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
  },
  async ({ latitude, longitude }) => {
    // Get grid point data
    const lat = latitude.toFixed(4);
    const lon = longitude.toFixed(4);
    const pointsUrl = `${NWS_API_BASE}/points/${lat},${lon}`;
    
    console.error(`Requesting forecast for coordinates: ${lat}, ${lon}`);
    console.error(`URL: ${pointsUrl}`);
    
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    if (!pointsData) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
          },
        ],
      };
    }

    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to get forecast URL from grid point data",
          },
        ],
      };
    }

    // Get forecast data
    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData || !forecastData.properties || !Array.isArray(forecastData.properties.periods)) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve valid forecast data",
          },
        ],
      };
    }

    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No forecast periods available",
          },
        ],
      };
    }

    // Format forecast periods
    const formattedForecast = periods.map((period: ForecastPeriod) =>
      [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
      ].join("\n"),
    );

    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;

    return wrapToolResponse({
      content: [
        {
          type: "text",
          text: forecastText,
        },
      ],
    });
  },
);

// Añadir una herramienta para obtener logs
server.tool(
  "get-logs",
  "Get recent server logs",
  {
    lines: z.number().min(1).max(100).optional().describe("Number of log lines to return (default: 20)")
  },
  async ({ lines = 20 }) => {
    const recentLogs = logBuffer.slice(-lines);
    
    return {
      content: [
        {
          type: "text",
          text: recentLogs.length > 0 
            ? "Recent server logs:\n\n" + recentLogs.join('\n')
            : "No logs available."
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});