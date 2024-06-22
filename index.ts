import {BigNumberish, ethers} from "ethers";
import type {TypedDataField} from "ethers/src.ts/hash";

import {OrderBook as IOrderBook, OrderBook__factory as OrderBookFactory} from "./typechain";
export {IOrderBook, OrderBookFactory};

export enum OrderSide {
    BUY = 0,
    SELL = 1,
}

export enum OrderCloseReason {
    FILLED = 0, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE, EXPIRED_IOK
}

export enum TimeInForce {
    GTC = 0, IOK, FOK
}


export const OrderBookContractAddress = {
    sepolia: "0xa1Fe9bE0043A40BFd6703A34106c522CD4Bb9f95",
    zkSyncSepolia: "0x319B526539a6c6311D1ed104Db38793657d0968F",
};

export const SUBMIT_ORDER_TYPES: Record<string, Array<TypedDataField>> = {
    "SubmitOrder": [
        {
            "name": "side",
            "type": "uint8"
        }, {
            "name": "price",
            "type": "uint256"
        }, {
            "name": "amount",
            "type": "uint256"
        }, {
            "name": "pairId",
            "type": "uint16"
        }, {
            "name": "validUntil",
            "type": "uint32"
        }, {
            "name": "tif",
            "type": "uint8"
        }, {
            "name": "networkFee",
            "type": "uint256"
        }, {
            "name": "nonce",
            "type": "uint256"
        }, {
            "name": "orderIdsToCancel",
            "type": "uint256[]"
        }
    ]
};

export async function signSubmitOrder(params: {
    signer: ethers.Signer;
    contract: IOrderBook;
    side: OrderSide;
    price: BigNumberish;
    amount: BigNumberish;
    pairId: BigNumberish;
    validUntil: BigNumberish;
    tif: TimeInForce;
    networkFee: BigNumberish;
    nonce: BigNumberish;
    orderIdsToCancel: BigNumberish[];
}) {
    const domain = await params.contract.eip712Domain();
    return await params.signer.signTypedData({
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
    }, SUBMIT_ORDER_TYPES, {
        side: params.side,
        price: params.price,
        amount: params.amount,
        pairId: params.pairId,
        validUntil: params.validUntil,
        tif: params.tif,
        networkFee: params.networkFee,
        nonce: params.nonce,
        orderIdsToCancel: params.orderIdsToCancel
    });
}
