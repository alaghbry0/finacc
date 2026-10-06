/**
 * (tabs)/_layout.tsx — شريط التبويبات الخمسة (LDR-2):
 * الرئيسية / المخزون / البيع (الزر الوسطي البارز) / النقدية / المزيد.
 * ⭐ طلب المالك: زر فتح شاشة البيع في منتصف شريط التنقل حرفياً —
 *   الترتيب أدناه يجعل مسار sales/new ثالث عنصر (المركز الهندسي 3/5)
 *   لأن RTL يرسم أول عنصر أقصى اليمين: الرئيسية (يمين) · المخزون · البيع (وسط) · النقدية · المزيد (يسار).
 * الشريط داكن #0F172A بحد علوي #334155، تسميات Tajawal 12،
 * النشط سماوي والخامل #CBD5E1 — الزر الوسطي مرفوع بهالة توهج وحلقة مزدوجة
 * وتفاعل ضغط (تكبير/تصغير) — والترتيب ينعكس تلقائياً في RTL.
 * شريط مخصص (لا tabBar الافتراضي) لتحكم كامل في الزر الوسطي وDS-29.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  House,
  LayoutGrid,
  Package,
  ShoppingCart,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import { ar } from '@/i18n/ar';
import { colors, font, radius, shadow, touch } from '@/theme';

const SALES_ROUTE = 'sales/new';

function FinTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}
      accessibilityRole="tablist"
    >
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const { options } = descriptors[route.key] ?? {};
          const label =
            typeof options?.title === 'string' && options.title !== ''
              ? options.title
              : route.name;
          const isCenter = route.name === SALES_ROUTE;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          if (isCenter) {
            /* ⭐ الزر الوسطي: هالة توهج + حلقة مزدوجة + أيقونة — يهبط قليلاً عند الضغط */
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: focused }}
                onPress={onPress}
                style={({ pressed }) => [
                  styles.centerSlot,
                  pressed && styles.centerSlotPressed,
                ]}
              >
                {/* هالة توهج شفافة خلف الزر — تتوهج أكثر وهو نشط */}
                <View
                  style={[styles.halo, focused && styles.haloActive]}
                  pointerEvents="none"
                />
                <View style={[styles.raiseRing, focused && styles.raiseRingActive]}>
                  <View style={[styles.raiseBtn, focused && styles.raiseBtnActive]}>
                    <ShoppingCart size={27} color={colors.onAccent} strokeWidth={2.2} />
                  </View>
                </View>
                <Text
                  style={[
                    styles.tabLabel,
                    { color: focused ? colors.accent : colors.textMuted },
                    focused && styles.tabLabelActive,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          }

          const icons: Record<string, LucideIcon> = {
            index: House,
            'inventory/index': Package,
            'cash/index': Wallet,
            more: LayoutGrid,
          };
          const Icon = icons[route.name] ?? House;
          const iconColor = focused ? colors.accent : colors.textMuted;

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: focused }}
              onPress={onPress}
              style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
            >
              {/* مؤشر نشط: حبة صغيرة فوق أيقونة التبويب الحالي (توجيه بصري) */}
              <View style={styles.tabIconWrap}>
                <View style={[styles.tabDot, focused && styles.tabDotActive]} />
                <Icon size={24} color={iconColor} />
              </View>
              <Text style={[styles.tabLabel, { color: iconColor }, focused && styles.tabLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <FinTabBar {...props} />} screenOptions={{ headerShown: false }}>
      {/* الترتيب = الترتيب البصري من اليمين في RTL — البيع ثالثاً (المركز الهندسي) */}
      <Tabs.Screen name="index" options={{ title: ar.tabs.home }} />
      <Tabs.Screen name="inventory/index" options={{ title: ar.tabs.inventory }} />
      <Tabs.Screen name="sales/new" options={{ title: ar.tabs.sales }} />
      <Tabs.Screen name="cash/index" options={{ title: ar.tabs.cash }} />
      <Tabs.Screen name="more" options={{ title: ar.tabs.more }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 60,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: touch.min + 8,
    paddingTop: 6,
  },
  tabPressed: {
    opacity: 0.75,
  },
  tabIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 26,
  },
  /* حبة المؤشر النشط — تظهر فقط للتبويب الحالي وتستقر فوق الأيقونة */
  tabDot: {
    position: 'absolute',
    top: -2,
    width: 16,
    height: 3,
    borderRadius: radius.full,
    backgroundColor: 'transparent',
  },
  tabDotActive: {
    backgroundColor: colors.accent,
  },
  /* ⭐ الزر الوسطي المرفوع */
  centerSlot: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    minHeight: touch.min + 8,
  },
  centerSlotPressed: {
    transform: [{ scale: 0.92 }],
    opacity: 0.9,
  },
  /* هالة توهج دائرية خلف الزر — نفس مركز الزر المرفوع تماماً */
  halo: {
    position: 'absolute',
    top: -30,
    width: 92,
    height: 92,
    borderRadius: radius.full,
    backgroundColor: 'rgba(34, 211, 238, 0.10)',
  },
  haloActive: {
    backgroundColor: 'rgba(34, 211, 238, 0.22)',
  },
  /* الحلقة الخارجية — أغمق قليلاً لتكوين حافة متدرجة بلا تدرّج خطي */
  raiseRing: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.gradientTo,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -27,
    borderWidth: 4,
    borderColor: colors.bg,
    ...shadow.floating,
  },
  raiseRingActive: {
    backgroundColor: '#38BDF8',
  },
  /* القرص الداخلي الفاتح — طبقتان تصنعان إيحاء تدرّج قطري */
  raiseBtn: {
    width: 50,
    height: 50,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  raiseBtnActive: {
    backgroundColor: '#7DEBFA',
  },
  tabLabel: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 17,
  },
  tabLabelActive: {
    fontFamily: font.bold,
  },
});
