/**
 * settings/numbering.tsx — الترقيم (FR-13-02 — قرار 6).
 *
 * لكل نوع مستند (INV/PUR/SRN/PRN/RVT/PMT): عدّاد السنة الجارية + عدد المستندات
 * الصادرة فعلاً + الرقم التالي بصيغته النهائية.
 *
 * رقم البداية: يُعدَّل **فقط قبل أول مستند من نوعه** — الصف المقفول يعرض رسالة
 * صادقة «صدرت مستندات — الرقم لا يُعدَّل بعد الإصدار» (قرار 6)؛ المفتوح يفتح
 * NumberPad (1 وأكبر) → setDocSequenceStart (قيد audit).
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Hash, Lock, PencilLine } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { listDocSequences, setDocSequenceStart, type DocSequenceRowInfo } from '@/domain/settings-ext';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { domainErrorMessage } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import BottomSheet from '@/components/ui/BottomSheet';
import ListRow from '@/components/ui/ListRow';
import NumberPad from '@/components/ui/NumberPad';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import { useFeedback } from '@/components/ui/feedback';

/** وصف المفاتيح في i18n بأسماء عربية */
function issuedLabel(row: DocSequenceRowInfo): string {
  if (row.issuedCount === 0) return ar.settings.numbering.issuedZero;
  if (row.issuedCount === 1) return ar.settings.numbering.issuedOne;
  return ar.settings.numbering.issued.replace('{n}', String(row.issuedCount));
}

export default function NumberingSettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<DocSequenceRowInfo[]>([]);
  const [editing, setEditing] = useState<DocSequenceRowInfo | null>(null);
  const [startValue, setStartValue] = useState('1');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = await getDb();
      setRows(await listDocSequences(db));
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openEditor = (row: DocSequenceRowInfo) => {
    if (row.locked) return; // مقفل — قرار 6 (رسالة القفل ظاهرة في السطر نفسه)
    setEditing(row);
    setStartValue('1');
  };

  const onSaveStart = async (): Promise<void> => {
    if (!editing || saving) return;
    const startNo = Number(startValue);
    if (!Number.isInteger(startNo) || startNo < 1) {
      feedback.show({ message: ar.settings.numbering.startInvalid });
      return;
    }
    setSaving(true);
    try {
      const db = await getDb();
      await setDocSequenceStart(db, editing.docType, editing.year, startNo);
      feedback.show({ message: `${ar.settings.numbering.startSaved} — ${editing.docType}-${editing.year}` });
      setEditing(null);
      await load();
    } catch (err) {
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.numbering}
        subtitle={ar.settings.numbering.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AppCard noPadding>
          {rows.map((row, i) => (
            <ListRow
              key={row.docType}
              title={ar.settings.numbering.docNames[row.docType] ?? row.docType}
              subtitle={`${ar.settings.numbering.nextNo}: ${row.nextNo} · ${issuedLabel(row)}`}
              divider={i < rows.length - 1}
              onPress={() => openEditor(row)}
              disabled={row.locked}
              testID={`numbering-row-${row.docType}`}
              leading={
                <View style={[styles.icon, { backgroundColor: `${colors.accent}22` }]}>
                  <Hash size={18} color={colors.accent} />
                </View>
              }
              trailing={
                row.locked ? (
                  <View style={styles.lockedBox}>
                    <Lock size={13} color={colors.textMuted} />
                    <Text style={styles.lockedText}>{ar.settings.numbering.locked}</Text>
                  </View>
                ) : (
                  <View style={styles.openBox}>
                    <PencilLine size={14} color={colors.accent} />
                    <Text style={styles.openText}>{ar.settings.numbering.startSheetTitle}</Text>
                  </View>
                )
              }
            />
          ))}
          {rows.length === 0 && !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{ar.settings.numbering.issuedZero}</Text>
            </View>
          ) : null}
        </AppCard>
        {feedback.host}
      </ScrollView>

      {/* رقم البداية — NumberPad (فقط للأنواع غير الصادرة) */}
      <BottomSheet
        visible={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing
            ? `${ar.settings.numbering.startSheetTitle} — ${ar.settings.numbering.docNames[editing.docType] ?? editing.docType}`
            : ar.settings.numbering.startSheetTitle
        }
        testID="numbering-start-sheet"
      >
        <Text style={styles.sheetHint}>{ar.settings.numbering.startHint}</Text>
        <NumberPad
          value={startValue}
          onChange={setStartValue}
          allowDecimal={false}
          decimals={0}
          label={ar.settings.numbering.startSheetTitle}
        />
        <PrimaryButton
          label={ar.common.save}
          onPress={onSaveStart}
          loading={saving}
          style={styles.sheetButton}
          testID="numbering-start-save"
        />
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    maxWidth: 150,
  },
  lockedText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
    flexShrink: 1,
  },
  openBox: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
  },
  openText: {
    color: colors.accent,
    fontFamily: font.medium,
    fontSize: 12.5,
  },
  empty: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 13,
  },
  sheetHint: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  sheetButton: {
    marginTop: spacing.md,
  },
});
