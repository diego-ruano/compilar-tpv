import { useNavigate } from "react-router-dom";

export default function NotFound() {
    const navigate = useNavigate();

    return (
        <div className="min-h-screen w-full bg-gris flex items-center justify-center p-6">
            <div className="max-w-xl w-full bg-blanco rounded-2xl shadow-md p-6 flex flex-col gap-4">
                <h1 className="text-3xl font-bold">404</h1>

                <p className="text-gray-600">
                    La página que intentas abrir no existe o no tienes acceso.
                </p>

                <button
                    onClick={() => navigate("/", { replace: true })}
                    className="px-4 py-2 rounded-xl bg-verde text-white font-semibold w-fit"
                >
                    Volver al menú principal
                </button>
            </div>
        </div>
    );
}
