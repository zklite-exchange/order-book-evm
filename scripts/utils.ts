import {ethers} from "ethers";
import hre from "hardhat";
import {DeployProxyOptions, getInitializerData, UpgradeProxyOptions} from "@openzeppelin/hardhat-upgrades/dist/utils";
import {Manifest} from "@matterlabs/hardhat-zksync-upgradable/dist/src/core/manifest";
import {getAdminAddress} from "@openzeppelin/upgrades-core/dist/eip-1967";
import {ProxyAdmin__factory} from "../typechain";
import {Provider, Wallet} from "zksync-ethers";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {deployProxyImpl} from "@matterlabs/hardhat-zksync-upgradable/dist/src/proxy-deployment/deploy-impl";
import {extractFactoryDeps} from "@matterlabs/hardhat-zksync-upgradable/dist/src/utils/utils-general";

export async function deployContract<T extends ethers.BaseContract>(owner: any, contractName: string, args: any[] = []): Promise<T> {
    let contract: T;
    if (hre.network.zksync) {
        hre.deployer.setWallet(owner);

        contract = await hre.deployer.deploy(contractName, args) as any;
    } else {
        contract = (await hre.ethers.deployContract(contractName, args, owner)) as any;
    }
    const gasUsed = (await contract.deploymentTransaction()?.wait())?.gasUsed;
    console.log(`Deploy ${contractName} cost ${gasUsed} gas`);
    return contract;
}

export async function deployProxy<T extends ethers.BaseContract>(
    owner: any, contractName: string,
    opts?: DeployProxyOptions & {
        initArgs?: any[];
    }
): Promise<T> {
    if (hre.network.zksync) {
        const manifest = await Manifest.forNetwork(owner.provider);
        const contractFactory = await hre.zksyncEthers.getContractFactory(contractName, owner);
        const {impl} = await deployProxyImpl(hre, contractFactory as any, {
            ...opts,
            provider: owner.provider,
            factoryDeps: await extractFactoryDeps(hre, await hre.deployer.loadArtifact(contractName)),
        });

        const data = getInitializerData(contractFactory.interface, opts?.initArgs ?? [], opts?.initializer);
        const proxy = await deployContract<T>(owner, "TransparentUpgradeableProxy", [impl, owner.address, data]);
        const deploymentTransaction = proxy.deploymentTransaction();
        await deploymentTransaction?.wait();
        await manifest.addProxy({
            kind: 'transparent',
            address: await proxy.getAddress(),
            txHash: deploymentTransaction?.hash,
            // @ts-ignore
            deployTransaction: deploymentTransaction
        });
        return contractFactory.attach(await proxy.getAddress()) as any;
    } else {
        const res = (await hre.upgrades.deployProxy(await hre.ethers.getContractFactory(contractName), opts?.initArgs ?? [], {
            ...opts,
            initialOwner: owner
        }));

        await res.deploymentTransaction()?.wait();
        return res as any;
    }
}

export async function upgradeProxy<T extends ethers.BaseContract>(
    admin: any, newImpl: string,
    proxy: ethers.BaseContract,
    opts: UpgradeProxyOptions
): Promise<T> {
    if (hre.network.zksync) {
        const contractFactory = await hre.zksyncEthers.getContractFactory(newImpl, admin);
        const {impl} = await deployProxyImpl(hre, contractFactory as any, {
            ...opts,
            provider: admin.provider,
            factoryDeps: await extractFactoryDeps(hre, await hre.deployer.loadArtifact(newImpl)),
        });
        const fn = typeof opts.call == "string" ? opts.call : opts.call?.fn;
        const initArgs = typeof opts.call == "string" ? [] : opts.call?.args ?? [];
        const data = fn ? getInitializerData(contractFactory.interface, initArgs, fn) : '0x';
        const proxyAddress = await proxy.getAddress();
        const adminContractAddress = await getAdminAddress(hre.network.provider, proxyAddress);
        const tx = await ProxyAdmin__factory.connect(adminContractAddress, admin)
            .upgradeAndCall(proxyAddress, impl, data);
        await tx.wait();
        return contractFactory.attach(proxyAddress) as any;
    }
    const res = await hre.upgrades.upgradeProxy(proxy, await hre.ethers.getContractFactory(newImpl, admin), opts) as any;
    await res.deployTransaction?.wait();
    return res;
}

export async function hreAccounts(): Promise<(HardhatEthersSigner | Wallet)[]> {
    const accounts = hre.network.zksync
        ? await hre.zksyncEthers.getWallets()
        : await hre.ethers.getSigners();

    if (hre.network.zksync) {
        const provider = new Provider((hre.network.config as any).url, undefined, {cacheTimeout: -1});
        return accounts.map((it: any) => it.connect(provider));
    }
    return accounts;
}
