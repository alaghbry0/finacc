/**
 * settings/company.tsx — بيانات المنشأة (FR-13-01 لاحقاً / FR-13-02).
 *
 * نموذج: الاسم (إلزامي) / الهاتف / واتساب / العنوان / الرقم الضريبي / تذييل
 * الفاتورة / بادئة الترقيم (2-6 لاتينية كبيرة أو أرقام) → updateCompanyProfile
 * (تحقق زود عربي + قيد audit) ثم session.refreshCompany حتى تلتقط الطباعة
 * والتذييل الجديدين فوراً.
 *
 * الشعار (logo): رفع صورة يتطلب image-picker أصلي → مؤجل V1.1 — ملاحظة صادقة
 * في أسفل الشاشة (لا حقل وهمي).
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ImageOff } from 'lucide-react-native';
import { getDb } from '@/db/client';
import { getCompanyProfile, updateCompanyProfile } from '@/domain/settings-ext';
import { useSession } from '@/store/session';
import { ar } from '@/i18n/ar';
import { colors, font, radius, spacing } from '@/theme';
import { domainErrorMessage, mapErrorToFields } from '@/utils/validation';
import AppCard from '@/components/ui/AppCard';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SafeScreen from '@/components/ui/SafeScreen';
import ScreenHeader from '@/components/ui/ScreenHeader';
import TextField from '@/components/ui/TextField';
import { useFeedback } from '@/components/ui/feedback';

interface FormState {
  name: string;
  phone: string;
  whatsapp: string;
  address: string;
  taxNumber: string;
  footerText: string;
  invoicePrefix: string;
}

const EMPTY: FormState = {
  name: '',
  phone: '',
  whatsapp: '',
  address: '',
  taxNumber: '',
  footerText: '',
  invoicePrefix: '',
};

export default function CompanySettingsScreen() {
  const router = useRouter();
  const feedback = useFeedback();
  const refreshCompany = useSession((s) => s.refreshCompany);

  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const db = await getDb();
      const profile = await getCompanyProfile(db);
      if (!alive) return;
      if (profile) {
        setForm({
          name: profile.name,
          phone: profile.phone ?? '',
          whatsapp: profile.whatsapp ?? '',
          address: profile.address ?? '',
          taxNumber: profile.tax_number ?? '',
          footerText: profile.footer_text ?? '',
          invoicePrefix: profile.invoice_prefix ?? '',
        });
      }
      setLoading(false);
    })().catch(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const set = (key: keyof FormState) => (text: string) => {
    setForm((f) => ({ ...f, [key]: text }));
  };

  const onSave = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setErrors({});
    try {
      const db = await getDb();
      await updateCompanyProfile(db, {
        name: form.name,
        phone: form.phone,
        whatsapp: form.whatsapp,
        address: form.address,
        taxNumber: form.taxNumber,
        footerText: form.footerText,
        invoicePrefix: form.invoicePrefix,
      });
      await refreshCompany();
      feedback.show({ message: ar.settings.saved });
    } catch (err) {
      setErrors(mapErrorToFields(err));
      feedback.show({ message: domainErrorMessage(err) ?? ar.settings.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeScreen scroll={false} offline={false} padded={false}>
      <ScreenHeader
        title={ar.settings.sections.company}
        subtitle={ar.settings.company.subtitle}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AppCard>
          <TextField
            label={ar.settings.company.name}
            value={form.name}
            onChangeText={set('name')}
            placeholder={ar.settings.company.namePh}
            error={errors.name ?? null}
            testID="company-name"
          />
          <View style={styles.row}>
            <View style={styles.half}>
              <TextField
                label={ar.settings.company.phone}
                value={form.phone}
                onChangeText={set('phone')}
                placeholder={ar.settings.company.phonePh}
                keyboardType="phone-pad"
                error={errors.phone ?? null}
                testID="company-phone"
              />
            </View>
            <View style={styles.half}>
              <TextField
                label={ar.settings.company.whatsapp}
                value={form.whatsapp}
                onChangeText={set('whatsapp')}
                placeholder={ar.settings.company.whatsappPh}
                keyboardType="phone-pad"
                error={errors.whatsapp ?? null}
                testID="company-whatsapp"
              />
            </View>
          </View>
          <TextField
            label={ar.settings.company.address}
            value={form.address}
            onChangeText={set('address')}
            placeholder={ar.settings.company.addressPh}
            error={errors.address ?? null}
            testID="company-address"
          />
          <TextField
            label={ar.settings.company.taxNumber}
            value={form.taxNumber}
            onChangeText={set('taxNumber')}
            placeholder={ar.settings.company.taxNumberPh}
            error={errors.taxNumber ?? null}
            testID="company-tax"
          />
          <TextField
            label={ar.settings.company.invoicePrefix}
            value={form.invoicePrefix}
            onChangeText={set('invoicePrefix')}
            placeholder="INV"
            hint={ar.settings.company.invoicePrefixHint}
            autoCapitalize="characters"
            error={errors.invoicePrefix ?? null}
            testID="company-prefix"
          />
          <TextField
            label={ar.settings.company.footerText}
            value={form.footerText}
            onChangeText={set('footerText')}
            placeholder={ar.settings.company.footerTextHint}
            error={errors.footerText ?? null}
            testID="company-footer"
          />
        </AppCard>

        <View style={styles.note}>
          <ImageOff size={16} color={colors.textMuted} />
          <Text style={styles.noteText}>{ar.settings.company.logoNote}</Text>
        </View>

        <PrimaryButton
          label={ar.common.save}
          onPress={onSave}
          loading={saving || loading}
          testID="company-save"
        />
        {feedback.host}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row-reverse',
    gap: spacing.md,
  },
  half: {
    flex: 1,
  },
  note: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: `${colors.pending}1F`,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noteText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
  },
});
