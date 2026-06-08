// src/shared/ui/ThemeToggle.tsx
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../stores/useTheme";
import IconButton, { type IconButtonProps } from "./IconButton";

export type ThemeToggleProps = Omit<IconButtonProps, "label" | "onClick" | "children">;

/**
 * Botón para alternar claro/oscuro. Usa el store useTheme (persistido).
 */
function ThemeToggle(props: ThemeToggleProps) {
    const theme = useTheme((s) => s.theme);
    const toggleTheme = useTheme((s) => s.toggleTheme);

    const isDark = theme === "dark";

    return (
        <IconButton
            {...props}
            label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
            onClick={toggleTheme}
        >
            {isDark ? (
                <Sun className="size-5" aria-hidden />
            ) : (
                <Moon className="size-5" aria-hidden />
            )}
        </IconButton>
    );
}

export default ThemeToggle;
