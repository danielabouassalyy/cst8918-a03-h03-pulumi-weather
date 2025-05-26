import { redis } from '../data-access/redis-connection';

const API_KEY = process.env.WEATHER_API_KEY!;
const BASE_URL = 'https://api.openweathermap.org/data/3.0/onecall';
const TEN_MINUTES = 1000 * 60 * 10; // ms

interface FetchWeatherDataParams {
  lat: number;
  lon: number;
  units: 'standard' | 'metric' | 'imperial';
}

export async function fetchWeatherData({
  lat,
  lon,
  units,
}: FetchWeatherDataParams) {
  const queryString = `lat=${lat}&lon=${lon}&units=${units}`;

  // Try cache
  const cacheEntry = await redis.get(queryString);
  if (cacheEntry) {
    return JSON.parse(cacheEntry);
  }

  // Fetch from API
  const response = await fetch(`${BASE_URL}?${queryString}&appid=${API_KEY}`);
  const dataText = await response.text();

  // Store in Redis (10min TTL)
  await redis.set(queryString, dataText, { PX: TEN_MINUTES });
  return JSON.parse(dataText);
}