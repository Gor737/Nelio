export type ErrorsType = {
    field: string,
    messages: string[]
};

export type ApiError = {
    statusCode: number;
    code: string;
    message: string,
    errors?: ErrorsType[];
};