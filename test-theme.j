import { PARSNIP_CHAOS_THEME } from './src/worker/theme-config.js';

// Test theme configuration
console.log('Theme Name:', PARSNIP_CHAOS_THEME.name);
console.log('Colors:', PARSNIP_CHAOS_THEME.colors);
console.log('Seasonal Themes:', Object.keys(PARSNIP_CHAOS_THEME.seasonal));

// Test seasonal switching
const testSeasonal = () => {
  const seasons = ['spring', 'summer', 'fall', 'winter'];
  seasons.forEach(season => {
    console.log(`${season}:`, PARSNIP_CHAOS_THEME.seasonal[season]);
  });
};

testSeasonal();