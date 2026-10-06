/**
 * OfflineBanner (DS-34) — شريط علوي رمادي «تعمل بلا إنترنت — كل بياناتك محفوظة
 * على جهازك». يخبر ولا يمنع أبداً (أوفلاين-أولاً).
 *
 * التحقق بلا اعتماديات إضافية: على الويب عبر navigator.onLine + حدثي
 * online/offline؛ على المنصات الأصلية يُخفي نفسه الآن (NetInfo لاحقاً عند الحاجة).
 */
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { font } from '@/theme';

function currentlyOffline(): boolean {
  if (Platform.OS === 'web') {
    try {
      return typeof navigator !== 'undefined' && navigator.onLine === false;
    } catch {
      return false;
    }
  }
  return false;
}

export default function OfflineBanner() {
  const [offline, setOffline] = useState<boolean>(currentlyOffline());

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <View style={styles.bar} accessibilityLiveRegion="polite" testID="offline-banner">
      <WifiOff size={14} color="#F1F5F9" />
      <Text style={styles.text}>{ar.components.offline.banner}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#475569',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    color: '#F1F5F9',
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
