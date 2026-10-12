// src/shared/ui/index.ts
// Punto único de import para los componentes UI base.
export { default as Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { default as IconButton } from "./IconButton";
export type {
    IconButtonProps,
    IconButtonVariant,
    IconButtonSize,
} from "./IconButton";

export { default as Card } from "./Card";
export type { CardProps } from "./Card";

export { default as Input } from "./Input";
export type { InputProps } from "./Input";

export { CampoDinero, useImporte } from "./CampoDinero";
export type { CampoDineroProps } from "./CampoDinero";

export { CampoHora } from "./CampoHora";
export type { CampoHoraProps } from "./CampoHora";

export { default as SearchInput } from "./SearchInput";
export type { SearchInputProps } from "./SearchInput";

export { default as Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { default as EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { default as SectionHeader } from "./SectionHeader";
export type { SectionHeaderProps } from "./SectionHeader";

export { default as ThemeToggle } from "./ThemeToggle";
export type { ThemeToggleProps } from "./ThemeToggle";

export { ModalShell } from "./ModalShell";
