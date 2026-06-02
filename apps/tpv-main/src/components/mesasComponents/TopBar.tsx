import { Link } from "react-router-dom";
import { ReactComponent as LapizSVG } from "../../assets/svg/LapizSVG.svg";

type TopBarProps = {
    canEditMesas?: boolean;
    isCocinero?: boolean;
};

export default function TopBar({
    canEditMesas = true,
    isCocinero = false,
}: TopBarProps) {
    return (
        <div className="flex gap-10 bg-blanco w-full p-4 rounded-xl shadow-xs justify-center items-center">
            <h2 className="text-2xl font-bold">
                {isCocinero ? "COMANDAS" : "MESAS"}
            </h2>

            {canEditMesas ? (
                <Link to="/Mesas/editar">
                    <div
                        className="
                          group flex gap-2 w-fit items-center cursor-pointer
                          border-2 border-verde rounded-xl px-3 py-1 text-verde
                          transition-all duration-300 ease-out
                          hover:bg-verde hover:text-white hover:shadow-md
                        "
                    >
                        <LapizSVG
                            width={24}
                            height={24}
                            className="transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-6"
                        />
                        <p className="font-medium">
                            Editar/Crear Mapa de Salones
                        </p>
                    </div>
                </Link>
            ) : null}
        </div>
    );
}
