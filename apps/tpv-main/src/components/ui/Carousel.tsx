import React, { useRef, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props<T> = {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  itemMinWidth?: number;
  gap?: number;
  loading?: boolean;
  emptyMessage?: string;
  desktopColumns?: number;
};

/**
 * Carousel responsivo:
 * - Desktop: grid con N columnas fijas
 * - Mobile: carrusel horizontal con scroll por drag y botones de flechas
 */
export default function Carousel<T>({
  items,
  renderItem,
  itemMinWidth = 140,
  gap = 12,
  loading = false,
  emptyMessage = "No hay items",
  desktopColumns = 3,
}: Props<T>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, scrollLeft: 0 });

  const checkScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 10
    );
  };

  useEffect(() => {
    checkScroll();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener("scroll", checkScroll);
      window.addEventListener("resize", checkScroll);

      return () => {
        container.removeEventListener("scroll", checkScroll);
        window.removeEventListener("resize", checkScroll);
      };
    }
  }, [items]);

  const scroll = (direction: "left" | "right") => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollDistance = itemMinWidth + gap;
    const newScrollLeft =
      direction === "left"
        ? container.scrollLeft - scrollDistance * 3
        : container.scrollLeft + scrollDistance * 3;

    container.scrollTo({
      left: newScrollLeft,
      behavior: "smooth",
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      scrollLeft: container.scrollLeft,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const walk = (e.clientX - dragStartRef.current.x) * 1;
    container.scrollLeft = dragStartRef.current.scrollLeft - walk;
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  if (loading) {
    return (
      <div className="text-sm text-negro/60">
        Cargando…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-negro/60">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Desktop Grid View */}
      <div
        className="hidden lg:grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${desktopColumns}, minmax(0, 1fr))`,
        }}
      >
        {items.map((item, index) => (
          <div key={index}>{renderItem(item, index)}</div>
        ))}
      </div>

      {/* Mobile/Tablet Carousel */}
      <div className="lg:hidden relative group">
        {/* Scroll Container */}
        <div
          ref={scrollContainerRef}
          className="flex gap-3 overflow-x-auto scroll-smooth scrollbar-hide"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            cursor: isDragging ? "grabbing" : "grab",
            scrollBehavior: "smooth",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {items.map((item, index) => (
            <div
              key={index}
              className="flex-shrink-0"
              style={{ width: `${itemMinWidth}px` }}
            >
              {renderItem(item, index)}
            </div>
          ))}
        </div>

        {/* Left Arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scroll("left")}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-10 sm:-translate-x-12 z-10 bg-blanco rounded-full p-2 shadow-md hover:shadow-lg transition-shadow"
            aria-label="Desplazar a la izquierda"
          >
            <ChevronLeft size={20} className="text-negro" />
          </button>
        )}

        {/* Right Arrow */}
        {canScrollRight && (
          <button
            onClick={() => scroll("right")}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-10 sm:translate-x-12 z-10 bg-blanco rounded-full p-2 shadow-md hover:shadow-lg transition-shadow"
            aria-label="Desplazar a la derecha"
          >
            <ChevronRight size={20} className="text-negro" />
          </button>
        )}
      </div>
    </div>
  );
}
