/**
 * OptionPickerSheet — منتقي مرجعية (فئة/وحدة/مخزن/عملة) في BottomSheet (DS-23):
 * قائمة ListRow بعلامة صح للمختار + خيار «بدون» اختياري.
 * ملاحظة تصميمية (المهمة 6-a): الإضافة السريعة أُسقطت بصدق — لا توجد دالة Domain
 * لإنشاء فئات/وحدات، والكتابة المباشرة تكسر NFR-09/11 — المنتقي يعرض الموجود فقط.
 */
import { View } from 'react-native';
import { Check } from 'lucide-react-native';
import ListRow from './ListRow';
import BottomSheet from './BottomSheet';
import { ar } from '@/i18n/ar';
import { colors } from '@/theme';

export type PickerOption = {
  id: number;
  label: string;
  /** سطر ثانٍ اختياري (رمز العملة مثلاً) */
  detail?: string;
};

export type OptionPickerSheetProps = {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedId: number | null;
  /** اختيار خيار — null عند اختيار «بدون» */
  onSelect: (id: number | null) => void;
  onClose: () => void;
  /** تفعيل خيار «بدون» أول القائمة */
  allowNone?: boolean;
  noneLabel?: string;
  /** تعطيل التبديل (منتقي مقفل) */
  disabled?: boolean;
  testID?: string;
};

/** حجز مكان بمقاس علامة الصح حتى تستقيم صفوف القائمة عمودياً */
function CheckSlot({ filled }: { filled: boolean }) {
  if (!filled) return <View style={{ width: 20, height: 20 }} />;
  return <Check size={20} color={colors.accent} />;
}

export default function OptionPickerSheet({
  visible,
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  allowNone = false,
  noneLabel,
  disabled = false,
  testID,
}: OptionPickerSheetProps) {
  const pick = (id: number | null) => {
    if (disabled) return;
    onSelect(id);
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} testID={testID}>
      {allowNone ? (
        <ListRow
          title={noneLabel ?? ar.inventory.form.noCategory}
          onPress={() => pick(null)}
          disabled={disabled}
          leading={<CheckSlot filled={selectedId === null} />}
        />
      ) : null}
      {options.map((opt) => (
        <ListRow
          key={opt.id}
          title={opt.label}
          subtitle={opt.detail}
          onPress={() => pick(opt.id)}
          disabled={disabled}
          leading={<CheckSlot filled={opt.id === selectedId} />}
        />
      ))}
    </BottomSheet>
  );
}
